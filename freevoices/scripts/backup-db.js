#!/usr/bin/env node
/**
 * Logical database snapshot: schema DDL + every row, as JSON.
 *
 *   node scripts/backup-db.js                 # writes ./backups/<db>-<stamp>.json
 *   node scripts/backup-db.js --out <path>
 *
 * This is a rollback net for schema migrations, not the production backup
 * strategy. It is UNENCRYPTED and contains personal information, so treat the
 * output as sensitive and delete it once it is no longer needed. The real
 * requirement — encrypted, 30-day, automatically purged, with a tested restore
 * — is a separate operational task.
 */

const fs = require('fs');
const path = require('path');
const { executeQuery, closePool } = require('../src/services/db.service');

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

(async () => {
  try {
    const [{ db }] = await executeQuery('SELECT DATABASE() AS db');
    const tables = (await executeQuery(
      'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = \'BASE TABLE\' ORDER BY TABLE_NAME'
    )).map(r => r.TABLE_NAME);

    const snapshot = { database: db, taken_at: new Date().toISOString(), tables: {} };
    let totalRows = 0;

    for (const table of tables) {
      const create = await executeQuery(`SHOW CREATE TABLE \`${table}\``);
      const rows = await executeQuery(`SELECT * FROM \`${table}\``);
      snapshot.tables[table] = {
        ddl: create[0]['Create Table'] || create[0]['Create View'],
        row_count: rows.length,
        rows,
      };
      totalRows += rows.length;
      console.log(`  ${table.padEnd(24)} ${String(rows.length).padStart(6)} rows`);
    }

    const outPath = outIndex !== -1 && args[outIndex + 1]
      ? path.resolve(args[outIndex + 1])
      : path.join(__dirname, '..', 'backups', `${db}-${timestamp()}.json`);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8');

    const kb = Math.round(fs.statSync(outPath).size / 1024);
    console.log(`\nSnapshot: ${tables.length} tables, ${totalRows} rows, ${kb} KB`);
    console.log(`Written to: ${outPath}`);
    console.log('\nUNENCRYPTED and contains personal information — delete when no longer needed.\n');

    await closePool();
    process.exit(0);
  } catch (err) {
    console.error(`\nBackup failed: ${err.message}\n`);
    await closePool();
    process.exit(1);
  }
})();
