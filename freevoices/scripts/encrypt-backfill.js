#!/usr/bin/env node
/**
 * Encrypt the personal-information columns that were written before the
 * encryption layer existed, and re-encrypt rows still on a retired key.
 *
 *   node scripts/encrypt-backfill.js --verify            # report only, no writes
 *   node scripts/encrypt-backfill.js --dry-run           # show what would change
 *   node scripts/encrypt-backfill.js                     # encrypt plaintext rows
 *   node scripts/encrypt-backfill.js --table=customers   # one table
 *   node scripts/encrypt-backfill.js --batch=200         # rows per batch
 *   node scripts/encrypt-backfill.js --rekey --from-key=1
 *   node scripts/encrypt-backfill.js --tokens            # SHA-256 the bearer tokens
 *
 * ── Why this is a script and not a migration ────────────────────────────────
 *
 * It must not gate boot. On a mature database a document_tracking rewrite can
 * take hours, and an app that will not start until it finishes is an outage.
 *
 * It does not need to, either: decryptField passes plaintext straight through,
 * so deployed code reads encrypted and unencrypted rows identically and the
 * application serves correctly for the entire duration of the run. That is the
 * property that makes this safe to do on a live system.
 *
 * And under a clustered process manager, N workers racing batched
 * read-modify-write over the same rows is not survivable — so this is run once,
 * by hand, by someone watching it.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 *
 * Migration 012 must have run first. Encrypting into a column that is still its
 * original width truncates the ciphertext, and outside strict mode MySQL does
 * that silently — the value is then gone. The pre-flight below refuses to start
 * if any target column is still too narrow.
 */

require('dotenv').config();

const { executeQuery, closePool, logger } = require('../src/services/db.service');
const ef = require('../src/services/encrypted-fields');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DRY_RUN = has('--dry-run');
const VERIFY = has('--verify');
const REKEY = has('--rekey');
const FROM_KEY = value('from-key', null);
const TOKENS = has('--tokens');
const ONLY_TABLE = value('table', null);
const BATCH = Math.max(1, parseInt(value('batch', '500'), 10) || 500);

/**
 * Columns the registry covers but this script deliberately leaves alone.
 *
 * document_tracking.user_agent is the biggest column in the schema on a mature
 * database, needs a full table rebuild, and not one line of application code
 * reads it. The 6-month retention policy will delete the backlog on its own;
 * everything written from now on is encrypted by the application. Paying for a
 * multi-hour rewrite of data that is on its way to being deleted, and that
 * nobody reads, buys nothing.
 */
const SKIP = new Set(['document_tracking.user_agent']);

/** Every registered column, minus the skips, minus anything --table excludes. */
function targets() {
  const out = [];
  for (const [table, columns] of Object.entries(ef.REGISTRY)) {
    if (ONLY_TABLE && table !== ONLY_TABLE) continue;
    for (const column of columns) {
      if (SKIP.has(`${table}.${column}`)) continue;
      out.push([table, column]);
    }
  }
  return out;
}

/**
 * Refuse to run against columns that are still their original width.
 *
 * This is the assertion that stands between a mistimed deploy and silent,
 * unrecoverable truncation of everyone's bank details.
 */
async function preflight(list) {
  const problems = [];
  for (const [table, column] of list) {
    const rows = await executeQuery(
      `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (rows.length === 0) { problems.push(`${table}.${column} does not exist`); continue; }

    const type = rows[0].COLUMN_TYPE.toLowerCase();
    const varchar = type.match(/^varchar\((\d+)\)$/);
    const wideEnough = type === 'mediumtext' || type === 'longtext'
      || (varchar && parseInt(varchar[1], 10) >= 255);
    if (!wideEnough) problems.push(`${table}.${column} is ${type} — too narrow for an envelope`);
  }

  if (problems.length) {
    console.error('\nPre-flight FAILED. Run `npm run migrate` first.\n');
    for (const p of problems) console.error(`  ${p}`);
    console.error('');
    throw new Error('columns are not wide enough to hold ciphertext');
  }
}

const countWhere = async (table, column, where) => {
  const rows = await executeQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`);
  return Number(rows[0].n);
};

const HAS_VALUE = (c) => `${c} IS NOT NULL AND ${c} <> ''`;

/**
 * Report without changing anything.
 *
 * The plaintext count is the number that matters: while it is above zero,
 * personal information is sitting in the clear in a column the privacy policy
 * describes as encrypted.
 */
async function verify(list) {
  console.log('\nCOLUMN                                    VALUES  PLAINTEXT  ENCRYPTED  READABLE');
  console.log('-'.repeat(84));

  let totalPlain = 0;
  let unreadable = 0;

  for (const [table, column] of list) {
    const filled = await countWhere(table, column, HAS_VALUE(column));
    const plain = await countWhere(table, column, `${HAS_VALUE(column)} AND ${column} NOT LIKE 'fv1.%'`);
    const enc = filled - plain;
    totalPlain += plain;

    // Prove the ciphertext is actually readable rather than trusting the
    // prefix — a wrong key or a mis-bound AAD looks identical from SQL.
    let readable = '-';
    if (enc > 0) {
      const sample = await executeQuery(
        `SELECT ${column} AS v FROM ${table} WHERE ${column} LIKE 'fv1.%' LIMIT 5`
      );
      let ok = 0;
      for (const row of sample) {
        try { ef.decryptField(table, column, row.v); ok += 1; } catch { /* counted below */ }
      }
      readable = `${ok}/${sample.length}`;
      if (ok < sample.length) unreadable += 1;
    }

    console.log(
      `${(table + '.' + column).padEnd(41)} ${String(filled).padStart(6)} ${String(plain).padStart(10)} ` +
      `${String(enc).padStart(10)}  ${readable}`
    );
  }

  for (const skipped of SKIP) console.log(`${skipped.padEnd(41)} (skipped by design)`);

  console.log('');
  if (unreadable > 0) {
    console.error(`${unreadable} column(s) hold ciphertext that will NOT decrypt with the current key. Do not proceed.`);
    return 1;
  }
  console.log(totalPlain === 0
    ? 'All registered columns are fully encrypted.'
    : `${totalPlain} value(s) still in plaintext — run without --verify to encrypt them.`);
  return 0;
}

/** Encrypt (or re-encrypt) one column, in batches, resumable. */
async function processColumn(table, column) {
  const match = REKEY
    ? `${column} LIKE ${escapeLiteral(`fv1.${FROM_KEY}$%`)}`
    : `${column} NOT LIKE 'fv1.%'`;
  const where = `${HAS_VALUE(column)} AND ${match}`;

  const pending = await countWhere(table, column, where);
  if (pending === 0) return 0;

  if (DRY_RUN) {
    console.log(`  ${table}.${column}: ${pending} row(s) would be ${REKEY ? 're-encrypted' : 'encrypted'}`);
    return pending;
  }

  let done = 0;
  // Re-query each round rather than paging by offset: every row processed stops
  // matching the WHERE, so "the next batch" is always just the first batch
  // again. That is what makes an interrupted run safe to simply re-run.
  for (;;) {
    const rows = await executeQuery(
      `SELECT id, ${column} AS v FROM ${table} WHERE ${where} ORDER BY id LIMIT ${BATCH}`
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      // On a rekey the value has to come back to plaintext first; decryptField
      // passes an unencrypted value through untouched, so the same code path
      // covers both modes.
      const plaintext = ef.decryptField(table, column, row.v);
      const envelope = ef.encryptField(table, column, plaintext);
      await executeQuery(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [envelope, row.id]);
      done += 1;
    }
    process.stdout.write(`  ${table}.${column}: ${done}/${pending}\r`);
  }

  console.log(`  ${table}.${column}: ${done} row(s) ${REKEY ? 're-encrypted' : 'encrypted'}        `);
  return done;
}

/**
 * Replace raw bearer tokens with their SHA-256 hash, in place.
 *
 * Every existing session, share link and pending reset keeps working: the
 * application hashes whatever arrives from the client and compares that, so the
 * value in the user's browser or inbox is still the right key to the row.
 *
 * Run this in the SAME deploy as the code that hashes on lookup. Deploy the
 * code without this and every lookup misses — everyone is logged out and every
 * share link 404s. Run this without the code and the same thing happens. There
 * is no ordering that makes the two independent, which is why it is one command
 * and not a background job.
 *
 * Raw tokens are UUIDs or 32-char hex; a hash is 64 hex characters. That is
 * what makes "already done" detectable, and the pass therefore idempotent.
 */
async function hashTokenColumns() {
  const HASHED = /^[0-9a-f]{64}$/;
  let total = 0;

  for (const [table, column] of ef.HASHED_TOKEN_COLUMNS) {
    const exists = await executeQuery(
      `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (Number(exists[0].n) === 0) { console.log(`  ${table}.${column}: not in this schema, skipped`); continue; }

    const rows = await executeQuery(
      `SELECT id, ${column} AS v FROM ${table}
        WHERE ${column} IS NOT NULL AND ${column} <> '' AND ${column} NOT REGEXP '^[0-9a-f]{64}$'`
    );
    if (rows.length === 0) { console.log(`  ${table}.${column}: already hashed`); continue; }

    if (DRY_RUN) {
      console.log(`  ${table}.${column}: ${rows.length} raw token(s) would be hashed`);
      total += rows.length;
      continue;
    }

    for (const row of rows) {
      // Belt and braces: never hash something that is already a hash.
      if (HASHED.test(String(row.v))) continue;
      await executeQuery(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [ef.hashToken(row.v), row.id]);
      total += 1;
    }
    console.log(`  ${table}.${column}: ${rows.length} token(s) hashed`);
  }
  return total;
}

/** Report on the token columns without changing them. */
async function verifyTokens() {
  console.log('\nTOKEN COLUMN                              VALUES        RAW     HASHED');
  console.log('-'.repeat(72));
  let raw = 0;
  for (const [table, column] of ef.HASHED_TOKEN_COLUMNS) {
    const exists = await executeQuery(
      `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (Number(exists[0].n) === 0) { console.log(`${(table + '.' + column).padEnd(41)} (not in this schema)`); continue; }

    const filled = await countWhere(table, column, HAS_VALUE(column));
    const rawCount = await countWhere(table, column, `${HAS_VALUE(column)} AND ${column} NOT REGEXP '^[0-9a-f]{64}$'`);
    raw += rawCount;
    console.log(
      `${(table + '.' + column).padEnd(41)} ${String(filled).padStart(6)} ${String(rawCount).padStart(10)} ` +
      `${String(filled - rawCount).padStart(10)}`
    );
  }
  console.log('');
  console.log(raw === 0
    ? 'All bearer tokens are hashed.'
    : `${raw} raw token(s) remain — run with --tokens to hash them.`);
  return raw;
}

/** MySQL string literal for a LIKE pattern we build ourselves. */
function escapeLiteral(text) {
  return `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

(async () => {
  try {
    // Hashing needs no key — it is deliberately unpeppered — so --tokens works
    // on a box that has not been given a keyring yet.
    if (!TOKENS && !ef.isEncryptionConfigured()) {
      throw new Error('DATA_ENCRYPTION_KEYS is not set — there is no key to encrypt with.');
    }
    if (REKEY && !FROM_KEY) {
      throw new Error('--rekey needs --from-key=<id> naming the key to migrate away from.');
    }

    const list = targets();
    if (list.length === 0) throw new Error(`No registered columns match --table=${ONLY_TABLE}`);

    if (!TOKENS) await preflight(list);

    if (VERIFY) {
      const fieldProblems = await verify(list);
      await verifyTokens();
      process.exitCode = fieldProblems;
      return;
    }

    if (TOKENS) {
      console.log(`\nHashing bearer tokens${DRY_RUN ? ' (dry run)' : ''}:\n`);
      const n = await hashTokenColumns();
      console.log('');
      console.log(n === 0 ? 'Nothing to do — every token is already hashed.'
        : DRY_RUN ? `${n} token(s) would be hashed.`
        : `${n} token(s) hashed.`);
      return;
    }

    console.log(REKEY
      ? `\nRe-encrypting values still on key "${FROM_KEY}"${DRY_RUN ? ' (dry run)' : ''}:\n`
      : `\nEncrypting plaintext values${DRY_RUN ? ' (dry run)' : ''}:\n`);

    let total = 0;
    for (const [table, column] of list) total += await processColumn(table, column);

    console.log('');
    if (total === 0) console.log('Nothing to do — every registered column is already encrypted.');
    else if (DRY_RUN) console.log(`${total} value(s) would be written. Re-run without --dry-run to apply.`);
    else {
      console.log(`${total} value(s) written.`);
      console.log('Re-run with --verify to confirm they all decrypt.');
    }
  } catch (err) {
    logger.error('Encryption backfill failed', { message: err.message });
    console.error(`\nBackfill failed: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
})();
