const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');

test('bank rows remain reviewable until a human confirms one safe match', { skip: !process.env.FREEVOICES_TEST_API_URL, timeout: 30000 }, async t => {
  const { executeQuery:q, closePool } = require('../src/services/db.service');
  const { todayIso } = require('../src/services/document-math');
  let uid;
  t.after(async()=>{
    try { if (uid) {
      await q('DELETE FROM bank_import_rows WHERE user_id=?',[uid]);
      await q('DELETE FROM documents WHERE user_id=?',[uid]);
      await q('DELETE FROM customers WHERE user_id=?',[uid]);
      await q('DELETE FROM sessions WHERE userId=?',[uid]);
      await q('DELETE FROM users WHERE id=?',[uid]);
    } } finally { await closePool(); }
  });
  uid=(await q('INSERT INTO users(email,company_name) VALUES(?,?)',[`bank-${randomUUID()}@example.test`,'Bank test'])).insertId;
  const auth=randomUUID();
  await q('INSERT INTO sessions(userId,token,expires) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))',[uid,createHash('sha256').update(auth).digest('hex')]);
  const base=process.env.FREEVOICES_TEST_API_URL.replace(/\/$/,'');
  const request=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const ok=async(...args)=>{const r=await request(...args);assert.ok(r.status<300,`${args[0]}: ${r.status} ${JSON.stringify(r.data)}`);return r.data;};
  const customer=await ok('/customers','POST',{name:'Bank buyer',email:'bank@example.test',billing_address:'Road'});
  const currency=(await q("SELECT id FROM currencies WHERE code='ZAR'"))[0].id;
  const invoice=await ok('/invoices','POST',{customer_id:customer.id,currency_id:currency,issue_date:todayIso(),items:[{description:'Work',quantity:1,unit_price:100,vat_rate:0}]});
  const csv=`date,amount,currency,description,reference,transaction_id,account\n${todayIso()},40.00,ZAR,Customer deposit,${invoice.document_number},TX-1,Business bank\n`;
  const preview=await ok('/bank-imports/preview','POST',{csv});
  assert.equal(preview.valid,true);
  assert.equal(preview.rows[0].duplicate,null);
  const imported=await ok('/bank-imports/commit','POST',{csv});
  assert.deepEqual([imported.created,imported.duplicates],[1,0]);
  assert.equal((await q('SELECT COUNT(*) AS total FROM payments WHERE document_id=?',[invoice.id]))[0].total,0);
  const repeat=await ok('/bank-imports/commit','POST',{csv});
  assert.deepEqual([repeat.created,repeat.duplicates],[0,1]);
  const rows=await ok('/bank-imports');
  assert.equal(rows.length,1);
  assert.equal(rows[0].reference,invoice.document_number);
  const suggestions=await ok(`/bank-imports/${rows[0].id}/suggestions`);
  assert.equal(suggestions[0].invoice_id,invoice.id);
  const match=await ok(`/bank-imports/${rows[0].id}/match`,'POST',{invoice_id:invoice.id});
  assert.equal(match.balance_due,'60.00');
  assert.equal((await request(`/bank-imports/${rows[0].id}/match`,'POST',{invoice_id:invoice.id})).status,409);
  assert.equal((await q('SELECT COUNT(*) AS total FROM payments WHERE document_id=?',[invoice.id]))[0].total,1);
  assert.equal((await ok('/bank-imports?status=MATCHED'))[0].payment_id,match.payment_id);
});
