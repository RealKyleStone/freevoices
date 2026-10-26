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
const { createCipheriv, randomBytes } = require('crypto');
const { getConnection, queryOn, closePool } = require('../src/services/db.service');

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const encrypted = args.includes('--encrypted');

function backupKey() {
  const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

(async () => {
  let connection;
  try {
    connection = await getConnection();
    const q = (sql, params) => queryOn(connection, {sql, dateStrings:true}, params);
    await q('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await q('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const [{ db }] = await q('SELECT DATABASE() AS db');
    const tables = (await q(
      'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = \'BASE TABLE\' ORDER BY TABLE_NAME'
    )).map(r => r.TABLE_NAME);

    const snapshot = { format_version: 2, database: db, taken_at: new Date().toISOString(), tables: {} };
    let totalRows = 0;

    for (const table of tables) {
      const create = await q(`SHOW CREATE TABLE \`${table}\``);
      const rows = await q(`SELECT * FROM \`${table}\``);
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
      : path.join(__dirname, '..', 'backups', `${db}-${timestamp()}.${encrypted ? 'fvbak' : 'json'}`);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    if (encrypted) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', backupKey(), iv);
      const body = Buffer.concat([cipher.update(JSON.stringify(snapshot), 'utf8'), cipher.final()]);
      fs.writeFileSync(outPath, Buffer.concat([Buffer.from('FVBAK1'),iv,cipher.getAuthTag(),body]), { flag:'wx' });
    } else fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), { encoding:'utf8',flag:'wx' });

    const kb = Math.round(fs.statSync(outPath).size / 1024);
    console.log(`\nSnapshot: ${tables.length} tables, ${totalRows} rows, ${kb} KB`);
    console.log(`Written to: ${outPath}`);
    console.log(encrypted ? '\nEncrypted backup. Store its key separately and test a restore.\n' : '\nUNENCRYPTED and contains personal information — delete when no longer needed.\n');

    await q('COMMIT');
    connection.release();
    connection = null;
    await closePool();
    process.exit(0);
  } catch (err) {
    console.error(`\nBackup failed: ${err.message}\n`);
    if (connection) {
      await queryOn(connection, 'ROLLBACK').catch(() => {});
      connection.release();
    }
    await closePool();
    process.exit(1);
  }
})();
