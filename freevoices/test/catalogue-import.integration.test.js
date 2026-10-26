const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');

test('catalogue CSV imports preview errors, commit atomically and replay safely', { skip: !process.env.FREEVOICES_TEST_API_URL, timeout: 30000 }, async t => {
  const { executeQuery: q, closePool } = require('../src/services/db.service');
  let uid;
  t.after(async () => {
    try {
      if (uid) {
        await q('DELETE FROM customers WHERE user_id=?',[uid]);
        await q('DELETE FROM products WHERE user_id=?',[uid]);
        await q('DELETE FROM sessions WHERE userId=?',[uid]);
        await q('DELETE FROM users WHERE id=?',[uid]);
      }
    } finally { await closePool(); }
  });
  uid = (await q('INSERT INTO users(email,company_name) VALUES(?,?)',[`import-${randomUUID()}@example.test`,'Import test'])).insertId;
  const token = randomUUID();
  await q('INSERT INTO sessions(userId,token,expires) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))',[uid,createHash('sha256').update(token).digest('hex')]);
  const base = process.env.FREEVOICES_TEST_API_URL.replace(/\/$/,'');
  const request = async (route,body) => {
    const response = await fetch(base+route,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const customerCsv = 'name,email,billing_address,phone,payment_terms\nA,a@example.test,Street,,0\nB,b@example.test,Road,,30\n';
  const badCsv = customerCsv.replace('b@example.test','a@example.test');
  const bad = await request('/imports/preview',{kind:'customers',csv:badCsv});
  assert.equal(bad.status,200);
  assert.equal(bad.data.valid,false);
  assert.equal((await request('/imports/commit',{kind:'customers',csv:badCsv})).status,422);
  assert.equal((await q('SELECT COUNT(*) AS total FROM customers WHERE user_id=?',[uid]))[0].total,0);
  const preview = await request('/imports/preview',{kind:'customers',csv:customerCsv});
  assert.equal(preview.data.valid,true);
  const committed = await request('/imports/commit',{kind:'customers',csv:customerCsv});
  assert.equal(committed.status,201);
  assert.equal(committed.data.count,2);
  assert.equal((await request('/imports/commit',{kind:'customers',csv:customerCsv})).data.replayed,true);
  assert.equal((await q('SELECT COUNT(*) AS total FROM customers WHERE user_id=?',[uid]))[0].total,2);
  const productCsv = 'name,price,description,vat_inclusive\nConsulting,115.00,Hourly,true\n';
  assert.equal((await request('/imports/commit',{kind:'products',csv:productCsv})).status,201);
  const products = await q('SELECT name,price,vat_inclusive FROM products WHERE user_id=?',[uid]);
  assert.equal(products[0].name,'Consulting');
  assert.equal(Number(products[0].price),115);
  assert.equal(products[0].vat_inclusive,1);
});
