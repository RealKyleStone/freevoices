#!/usr/bin/env node
/**
 * Deployment preflight. Read-only — safe to run any time, on production.
 *
 *   node scripts/doctor.js
 *
 * Checks, in order of how early they would bite:
 *   1. Node version against what the dependencies require
 *   2. Every runtime module actually loads — this is what catches argon2, the
 *      one native module, failing to build or mismatching the Node ABI
 *   3. Required environment variables are present (names only; never values)
 *   4. The database is reachable and every migration is applied
 *   5. The Angular build is present where Express expects it
 *   6. Which legal documents are published
 *
 * Exits non-zero if anything would stop the app from working.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIN_NODE_MAJOR = 18;

/**
 * Both module lists are READ FROM THE DEPLOYED CODE, never hardcoded.
 *
 * An earlier hardcoded list is exactly why this script once reported "Ready to
 * serve" while the site returned 500 for every route: server.js had gained
 * `require('google-auth-library')`, which was neither in the list here nor in
 * the shipped package.json, so it was never installed. The server died at
 * require time before winston existed — no log line — and doctor cheerfully
 * checked fifteen other modules and declared everything fine.
 *
 * Deriving from the real files means doctor can only get more accurate as the
 * code changes, never less.
 */
const SERVER_FILES = (() => {
  const files = [path.join(ROOT, 'server.js')];
  const servicesDir = path.join(ROOT, 'src', 'services');
  if (fs.existsSync(servicesDir)) {
    for (const f of fs.readdirSync(servicesDir)) {
      if (f.endsWith('.js')) files.push(path.join(servicesDir, f));
    }
  }
  return files.filter((f) => fs.existsSync(f));
})();

function requiresIn(file) {
  const contents = fs.readFileSync(file, 'utf8');
  const bare = [];
  const relative = [];
  for (const m of contents.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1];
    if (spec.startsWith('.')) relative.push(spec);
    else bare.push(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
  }
  return { bare, relative };
}

const BUILTINS = new Set(require('module').builtinModules);
const RUNTIME_MODULES = [...new Set(
  SERVER_FILES.flatMap((f) => requiresIn(f).bare).filter((m) => !BUILTINS.has(m))
)].sort();

const REQUIRED_ENV = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'APP_URL'];
const RECOMMENDED_ENV = [
  'NODE_ENV', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  'RECAPTCHA_SECRET_KEY', 'TRUST_PROXY_HOPS', 'CORS_ALLOWED_ORIGINS',
];

let failures = 0;
let warnings = 0;

const pass = (msg) => console.log(`  ok      ${msg}`);
const fail = (msg) => { failures++; console.log(`  FAIL    ${msg}`); };
const warn = (msg) => { warnings++; console.log(`  warn    ${msg}`); };
const section = (t) => console.log(`\n${t}`);

(async () => {
  console.log('\nFreeVoices deployment doctor');
  console.log('='.repeat(60));

  // 1. Node version
  section('Node runtime');
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= MIN_NODE_MAJOR) pass(`Node ${process.version} (needs >= ${MIN_NODE_MAJOR})`);
  else fail(`Node ${process.version} is too old — helmet requires >= ${MIN_NODE_MAJOR}`);

  // 2. Runtime modules. Done before anything else touches them, because a
  //    native module that failed to build is the most common deploy failure and
  //    it presents as an unrelated crash later.
  section('Runtime modules');
  for (const m of RUNTIME_MODULES) {
    try {
      require(m);
      pass(m);
    } catch (err) {
      const hint = /NODE_MODULE_VERSION|was compiled against/.test(err.message)
        ? ' (built for a different Node version — reinstall it)'
        : /Cannot find module/.test(err.message)
          ? ' (not installed — run npm install)'
          : '';
      fail(`${m} — ${err.message.split('\n')[0]}${hint}`);
    }
  }

  // Load .env only after dotenv is known to exist.
  try { require('dotenv').config({ quiet: true }); } catch { /* reported above */ }

  // 3. Environment
  section('Environment variables');
  for (const key of REQUIRED_ENV) {
    if (process.env[key]) pass(`${key} is set`);
    else fail(`${key} is NOT set`);
  }
  for (const key of RECOMMENDED_ENV) {
    if (process.env[key]) pass(`${key} is set`);
    else warn(`${key} is not set`);
  }
  if (process.env.NODE_ENV !== 'production') {
    warn(`NODE_ENV is "${process.env.NODE_ENV || '(unset)'}" — CAPTCHA and HSTS are disabled unless it is "production"`);
  }
  const host = process.env.DB_HOST || '';
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && (process.env.DB_SSL || 'required') === 'disabled') {
    fail('DB_HOST is remote but DB_SSL=disabled — credentials would cross the network in cleartext');
  }
  for (const leaky of ['SMTP_DEBUG', 'RATE_LIMIT_DISABLED', 'CAPTCHA_DISABLED', 'SMTP_TLS_INSECURE']) {
    if (process.env[leaky] === 'true') warn(`${leaky}=true — not appropriate for production`);
  }

  // 4. Static build
  section('Angular build');
  const indexPath = path.join(ROOT, 'www', 'index.html');
  if (fs.existsSync(indexPath)) {
    const bytes = fs.statSync(indexPath).size;
    pass(`www/index.html present (${bytes} bytes)`);
    const jsCount = fs.readdirSync(path.join(ROOT, 'www')).filter((f) => f.endsWith('.js')).length;
    if (jsCount > 10) pass(`www/ contains ${jsCount} JavaScript bundles`);
    else fail(`www/ has only ${jsCount} .js files — the build looks incomplete`);
    // A backslash-named file here means a Windows-made zip was extracted on
    // Linux, which silently flattens every path.
    const flattened = fs.readdirSync(ROOT).filter((f) => f.includes('\\'));
    if (flattened.length) {
      fail(`${flattened.length} file(s) with backslashes in the name, e.g. "${flattened[0]}" — ` +
           'an archive was extracted with literal Windows paths. Delete them and re-extract a tar.gz.');
    }
  } else {
    fail('www/index.html is MISSING — Express has nothing to serve');
  }

  section('Server files');
  for (const rel of ['server.js', 'package.json']) {
    if (fs.existsSync(path.join(ROOT, rel))) pass(rel);
    else fail(`${rel} is MISSING`);
  }
  // Every local require must resolve. A missing service file kills the process
  // at require time, which no amount of module or database checking would see.
  let brokenLocal = 0;
  for (const file of SERVER_FILES) {
    for (const spec of requiresIn(file).relative) {
      const base = path.resolve(path.dirname(file), spec);
      const found = [base, base + '.js', base + '.json', path.join(base, 'index.js')]
        .some((c) => fs.existsSync(c) && fs.statSync(c).isFile());
      if (!found) {
        brokenLocal++;
        fail(`${path.relative(ROOT, file).split(path.sep).join('/')} requires ${spec} — NOT FOUND`);
      }
    }
  }
  if (brokenLocal === 0) pass(`all local requires resolve (${SERVER_FILES.length} server file(s) scanned)`);

  // 5 & 6. Database. Last, because it is the only check with a network cost,
  //        and pointless if the modules above did not load.
  if (failures === 0 || RUNTIME_MODULES.every((m) => { try { require.resolve(m); return true; } catch { return false; } })) {
    section('Database');
    let db;
    try {
      db = require('../src/services/db.service');
      const rows = await db.executeQuery('SELECT DATABASE() AS db, VERSION() AS version');
      pass(`connected to "${rows[0].db}" (${rows[0].version})`);

      const { MIGRATIONS } = require('../src/services/migrations.service');
      const ledger = await db.executeQuery(
        "SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'"
      );
      if (ledger[0].cnt === 0) {
        warn('schema_migrations does not exist — migrations will run on first boot');
      } else {
        const applied = new Set((await db.executeQuery('SELECT id FROM schema_migrations')).map((r) => r.id));
        const pending = MIGRATIONS.filter((m) => !applied.has(m.id));
        if (pending.length === 0) pass(`all ${MIGRATIONS.length} migrations applied`);
        else warn(`${pending.length} migration(s) pending, will apply on boot: ${pending.map((m) => m.id).join(', ')}`);
      }

      const legal = await db.executeQuery(
        "SELECT slug, version, is_current FROM legal_documents ORDER BY slug"
      ).catch(() => null);
      if (legal) {
        section('Legal documents');
        const published = legal.filter((d) => d.is_current);
        for (const d of legal) {
          if (d.is_current) pass(`${d.slug} v${d.version} published`);
          else warn(`${d.slug} v${d.version} NOT published (unresolved placeholders — run seed:legal:check)`);
        }
        if (!published.some((d) => d.slug === 'delete-account')) {
          fail('delete-account is not published — Google Play requires that URL to work');
        }
      }
    } catch (err) {
      fail(`database — ${err.code || ''} ${err.message.split('\n')[0]}`);
    } finally {
      if (db) await db.closePool().catch(() => {});
    }
  }

  console.log('\n' + '='.repeat(60));
  if (failures) {
    console.log(`${failures} failure(s), ${warnings} warning(s). The app will not work correctly.\n`);
    process.exit(1);
  }
  console.log(`No failures${warnings ? `, ${warnings} warning(s)` : ''}. Ready to serve.\n`);
  process.exit(0);
})();
