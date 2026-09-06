#!/usr/bin/env node
/**
 * Load the reviewable HTML in `legal/` into the `legal_documents` table.
 *
 *   node scripts/seed-legal.js --check    # report only, no writes
 *   node scripts/seed-legal.js            # insert/update, publish if complete
 *   node scripts/seed-legal.js --publish-with-placeholders   # override the gate
 *
 * The gate: a document containing an unresolved [[PLACEHOLDER]] is stored but
 * NOT marked current, so the public page and the app keep serving the previous
 * version rather than publishing a legal document with visible fill-me-ins.
 *
 * To revise a document, edit the file in `legal/`, bump its version here, and
 * re-run. Published versions are never mutated in place — acceptance records
 * reference a version, so rewriting one would invalidate the audit trail.
 */

const fs = require('fs');
const path = require('path');
const { executeQuery, withTransaction, closePool, logger } = require('../src/services/db.service');

const LEGAL_DIR = path.join(__dirname, '..', 'legal');
// Offline copies bundled into the Angular build. Generated here, from the same
// source as the database rows, so the two cannot drift.
const ASSET_DIR = path.join(__dirname, '..', 'src', 'assets', 'legal');

// Bump `version` whenever the text changes materially, and move
// `effective_date` with it. Material changes also require 14 days' notice and
// (per the policy's own section 14) re-acceptance.
const DOCUMENTS = [
  {
    slug: 'privacy',
    // 1.1.0 — discloses Google Sign-In as an optional third party and a
    // section 72 cross-border transfer. Set the effective date to 14 days after
    // you publish, per the notice period the policy commits to in section 14.
    version: '1.1.0',
    title: 'Privacy Policy',
    effective_date: '2026-09-16',
    file: 'privacy-policy.html',
    summary_html: '<p>Adds Google Sign-In. If you choose to sign in with your Google account, Google receives your IP address and confirms your email address and name to us. Signing in with a password is unchanged and sends Google nothing.</p>',
  },
  {
    slug: 'terms',
    version: '1.0.0',
    title: 'Terms of Service',
    effective_date: '2026-08-17',
    file: 'terms.html',
    summary_html: '<p>Our first published Terms of Service.</p>',
  },
  {
    slug: 'delete-account',
    version: '1.0.0',
    title: 'Delete Your Account',
    effective_date: '2026-08-17',
    file: 'delete-account.html',
    summary_html: null,
  },
];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const allowPlaceholders = args.includes('--publish-with-placeholders');

/** Drop the leading authoring comment so it never reaches a published page. */
function loadBody(file) {
  const raw = fs.readFileSync(path.join(LEGAL_DIR, file), 'utf8');
  return raw.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
}

function findPlaceholders(html) {
  return [...new Set(html.match(/\[\[[A-Z0-9_]+\]\]/g) || [])];
}

(async () => {
  let blocked = 0;

  try {
    const report = [];

    for (const doc of DOCUMENTS) {
      const content = loadBody(doc.file);
      const placeholders = findPlaceholders(content);
      const publishable = placeholders.length === 0 || allowPlaceholders;
      if (!publishable) blocked++;

      report.push({ doc, content, placeholders, publishable });
    }

    console.log('');
    for (const { doc, content, placeholders, publishable } of report) {
      console.log(`${doc.slug} v${doc.version} — ${doc.title}`);
      console.log(`  ${content.length.toLocaleString()} chars, effective ${doc.effective_date}`);
      if (placeholders.length) {
        console.log(`  ${publishable ? 'OVERRIDDEN' : 'NOT PUBLISHABLE'} — ${placeholders.length} unresolved placeholder(s):`);
        for (const p of placeholders) console.log(`      ${p}`);
      } else {
        console.log('  no unresolved placeholders');
      }
      console.log('');
    }

    if (checkOnly) {
      console.log(blocked ? `${blocked} document(s) would NOT be published.\n` : 'All documents are publishable.\n');
      await closePool();
      process.exit(blocked ? 1 : 0);
    }

    for (const { doc, content, publishable } of report) {
      await withTransaction(async (q) => {
        const existing = await q(
          'SELECT id, content_html FROM legal_documents WHERE slug = ? AND version = ?',
          [doc.slug, doc.version]
        );

        if (existing.length === 0) {
          await q(
            `INSERT INTO legal_documents (slug, version, title, effective_date, summary_html, content_html, is_current)
             VALUES (?, ?, ?, ?, ?, ?, 0)`,
            [doc.slug, doc.version, doc.title, doc.effective_date, doc.summary_html, content]
          );
          console.log(`inserted ${doc.slug} v${doc.version}`);
        } else if (existing[0].content_html !== content) {
          // Safe only because nothing has been published yet at this version, or
          // because the edit is a correction to an unpublished draft. Bump the
          // version for anything a user may already have accepted.
          await q('UPDATE legal_documents SET title = ?, effective_date = ?, summary_html = ?, content_html = ? WHERE id = ?',
            [doc.title, doc.effective_date, doc.summary_html, content, existing[0].id]);
          console.log(`updated  ${doc.slug} v${doc.version} (content changed)`);
        } else {
          console.log(`unchanged ${doc.slug} v${doc.version}`);
        }

        if (publishable) {
          // Exactly one current version per slug.
          await q('UPDATE legal_documents SET is_current = 0 WHERE slug = ?', [doc.slug]);
          await q('UPDATE legal_documents SET is_current = 1 WHERE slug = ? AND version = ?', [doc.slug, doc.version]);
          console.log(`  -> published as current`);
        } else {
          await q('UPDATE legal_documents SET is_current = 0 WHERE slug = ? AND version = ?', [doc.slug, doc.version]);
          console.log(`  -> stored but NOT published (unresolved placeholders)`);
        }
      });
    }

    // Only publishable documents get an offline copy. Bundling a version that
    // is not fit to publish would let the app display it while offline.
    fs.mkdirSync(ASSET_DIR, { recursive: true });
    for (const { doc, content, publishable } of report) {
      const target = path.join(ASSET_DIR, `${doc.slug}.html`);
      if (publishable) {
        fs.writeFileSync(target, content, 'utf8');
        console.log(`  wrote offline copy src/assets/legal/${doc.slug}.html`);
      } else if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        console.log(`  removed stale offline copy src/assets/legal/${doc.slug}.html`);
      }
    }

    // DATE_FORMAT in SQL, not new Date(...).toISOString(): mysql2 hands back a
    // DATE as local midnight, so converting to UTC reports the previous day in
    // any timezone east of Greenwich — including SAST.
    const current = await executeQuery(
      `SELECT slug, version, DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date, is_current
         FROM legal_documents ORDER BY slug, version`
    );
    console.log('\nlegal_documents now contains:');
    for (const r of current) {
      console.log(`  ${r.slug.padEnd(16)} v${r.version}  ${r.is_current ? 'CURRENT' : '-      '}  effective ${r.effective_date}`);
    }

    if (blocked) {
      console.log(`\n${blocked} document(s) are stored but unpublished because placeholders remain.`);
      console.log('Fill them in under legal/, then re-run this script. Nothing is served until then.\n');
    } else {
      console.log('\nAll documents published.\n');
    }

    await closePool();
    process.exit(0);
  } catch (err) {
    logger.error('Legal seed failed', { message: err.message });
    console.error(`\nSeed failed: ${err.message}\n`);
    await closePool();
    process.exit(1);
  }
})();
