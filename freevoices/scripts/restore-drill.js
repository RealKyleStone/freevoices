#!/usr/bin/env node
/** Restore an encrypted FreeVoices snapshot only into a new local test DB. */
require('dotenv').config();
const fs=require('fs');
const path=require('path');
const {createDecipheriv}=require('crypto');
const {getConnection,queryOn,closePool}=require('../src/services/db.service');
const {verifyCanary}=require('../src/services/encrypted-fields');

const file=process.argv[2];
const db=process.env.DB_NAME || '';
const host=process.env.DB_HOST || '';
if (!file || !fs.existsSync(file)) throw new Error('Provide an existing .fvbak file');
if (!/^freevoices_test_[a-z0-9_]+$/i.test(db) || !['127.0.0.1','localhost'].includes(host) || process.env.NODE_ENV==='production')
  throw new Error('Restore drill requires a new local freevoices_test_* database and non-production mode');
const key=Buffer.from(process.env.BACKUP_ENCRYPTION_KEY || '','base64');
if (key.length!==32) throw new Error('BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes');
const bytes=fs.readFileSync(path.resolve(file));
if (bytes.length<34 || bytes.subarray(0,6).toString()!=='FVBAK1') throw new Error('Not a FreeVoices encrypted backup');
const iv=bytes.subarray(6,18),tag=bytes.subarray(18,34);
const decipher=createDecipheriv('aes-256-gcm',key,iv);
decipher.setAuthTag(tag);
const snapshot=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(34)),decipher.final()]).toString('utf8'));
if (snapshot.format_version!==2 || !snapshot.tables || typeof snapshot.tables!=='object') throw new Error('Unsupported snapshot format');
const names=Object.keys(snapshot.tables);
if (!names.length || names.some(name=>!/^[A-Za-z0-9_]+$/.test(name))) throw new Error('Invalid table inventory');

(async()=>{
  let conn;
  try {
    conn=await getConnection();
    const q=(sql,params)=>queryOn(conn,{sql,dateStrings:true},params);
    const existing=await q('SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    if (existing[0].total!==0) throw new Error('Restore target is not empty');
    await q('SET FOREIGN_KEY_CHECKS=0');
    for(const name of names) {
      const table=snapshot.tables[name];
      if (!table.ddl || !Array.isArray(table.rows) || table.rows.length!==table.row_count) throw new Error(`Invalid ${name} snapshot`);
      await q(table.ddl);
    }
    for(const name of names) {
      const table=snapshot.tables[name];
      for(const row of table.rows) {
        const columns=Object.keys(row);
        if (columns.some(column=>!/^[A-Za-z0-9_]+$/.test(column))) throw new Error(`Invalid ${name} column`);
        const values=columns.map(column=>row[column]?.type==='Buffer' ? Buffer.from(row[column].data) : row[column]);
        await q(`INSERT INTO \`${name}\` (${columns.map(column=>`\`${column}\``).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`,values);
      }
      const count=await q(`SELECT COUNT(*) AS total FROM \`${name}\``);
      if (count[0].total!==table.row_count) throw new Error(`Row count mismatch in ${name}`);
    }
    await q('SET FOREIGN_KEY_CHECKS=1');
    conn.release(); conn=null;
    await verifyCanary();
    console.log(`Restore drill passed: ${names.length} tables in ${db}; encryption key verified.`);
  } catch(error) {
    console.error(`Restore drill failed: ${error.message}`);
    process.exitCode=1;
  } finally {
    if(conn) { await queryOn(conn,'SET FOREIGN_KEY_CHECKS=1').catch(()=>{}); conn.release(); }
    await closePool();
  }
})();
