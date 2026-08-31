#!/usr/bin/env node
/**
 * Apply pending schema migrations from the command line.
 *
 *   node scripts/migrate.js --dry-run    # read-only: list what would run
 *   node scripts/migrate.js --status     # read-only: applied vs pending
 *   node scripts/migrate.js              # apply
 *
 * The server also runs migrations on boot; this exists so you can inspect and
 * apply against a restored copy of production before letting it near the real
 * thing, and so a deploy can migrate as an explicit, observable step.
 */

const { runMigrations, MIGRATIONS } = require('../src/services/migrations.service');
const { executeQuery, closePool } = require('../src/services/db.service');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const statusOnly = args.includes('--status');

async function showStatus() {
  // Probe rather than catch, so an expected first-run state doesn't get logged
  // as a query error.
  const ledger = await executeQuery(
    "SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'"
  );

  let applied = [];
  if (ledger[0].cnt === 0) {
    console.log('schema_migrations does not exist yet — nothing has been applied.\n');
  } else {
    applied = await executeQuery('SELECT id, applied_at, result FROM schema_migrations ORDER BY applied_at');
  }

  const appliedIds = new Set(applied.map(r => r.id));
  console.log(`${MIGRATIONS.length} migration(s) defined:\n`);
  for (const m of MIGRATIONS) {
    const row = applied.find(r => r.id === m.id);
    const mark = appliedIds.has(m.id) ? 'applied ' : 'PENDING ';
    const when = row ? new Date(row.applied_at).toISOString().slice(0, 19).replace('T', ' ') : '';
    console.log(`  [${mark}] ${m.id}${when ? `   ${when}` : ''}`);
    if (row && row.result) console.log(`             -> ${row.result}`);
  }
  console.log();
}

(async () => {
  try {
    if (statusOnly) {
      await showStatus();
    } else {
      const { applied, pending } = await runMigrations({ dryRun });
      if (dryRun) {
        console.log(pending.length
          ? `\nDry run — ${pending.length} migration(s) would be applied:\n  ${pending.join('\n  ')}\n`
          : '\nDry run — schema is up to date.\n');
      } else {
        console.log(applied.length
          ? `\nApplied ${applied.length} migration(s):\n  ${applied.join('\n  ')}\n`
          : '\nSchema is up to date; nothing to apply.\n');
      }
    }
    await closePool();
    process.exit(0);
  } catch (err) {
    console.error(`\nMigration run failed: ${err.message}\n`);
    if (err.stack) console.error(err.stack);
    await closePool();
    process.exit(1);
  }
})();
