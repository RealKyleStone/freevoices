const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');

test('customer quote decisions are recorded once and govern conversion', { skip: !process.env.FREEVOICES_TEST_API_URL, timeout: 30000 }, async t => {
  const { executeQuery: q, closePool } = require('../src/services/db.service');
  const { todayIso } = require('../src/services/document-math');
  let uid;
  t.after(async () => {
    try {
      if (uid) {
        await q('DELETE FROM documents WHERE user_id=?', [uid]);
        await q('DELETE FROM customers WHERE user_id=?', [uid]);
        await q('DELETE FROM sessions WHERE userId=?', [uid]);
        await q('DELETE FROM users WHERE id=?', [uid]);
      }
    } finally { await closePool(); }
  });
  uid = (await q('INSERT INTO users(email,company_name) VALUES(?,?)', [`quote-${randomUUID()}@example.test`, 'Quote seller'])).insertId;
  const auth = randomUUID();
  await q('INSERT INTO sessions(userId,token,expires) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))', [uid, createHash('sha256').update(auth).digest('hex')]);
  const base = process.env.FREEVOICES_TEST_API_URL.replace(/\/$/, '');
  assert.equal((await fetch(base + '/health/ready')).status, 200);
  const request = async (route, method = 'GET', body, authorized = true, pdf = false) => {
    const response = await fetch(base + route, { method, headers: { ...(authorized ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: pdf && response.ok ? Buffer.from(await response.arrayBuffer()) : await response.json() };
  };
  const ok = async (...args) => { const result = await request(...args); assert.ok(result.status < 300, `${args[0]}: ${result.status} ${JSON.stringify(result.data)}`); return result.data; };
  const customer = await ok('/customers', 'POST', { name: 'Quote customer', email: 'quote@example.test', billing_address: 'Test address' });
  const currencyId = (await q("SELECT id FROM currencies WHERE code='ZAR'"))[0].id;
  const payload = { customer_id: customer.id, currency_id: currencyId, issue_date: todayIso(), valid_until: '2099-12-31', items: [{ description: 'Service', quantity: 1, unit_price: 100, vat_rate: 15 }] };

  const accepted = await ok('/quotes', 'POST', payload);
  const link = await ok(`/quotes/${accepted.id}/share`, 'POST', {});
  assert.match(link.share_url, /\/portal\/quote\/[0-9a-f]{32}$/);
  const token = link.share_url.split('/').pop();
  const review = await ok(`/public/quote/${token}`, 'GET', undefined, false);
  assert.equal(review.status, 'SENT');
  assert.equal(review.items[0].description, 'Service');
  assert.equal((await request(`/public/quote/${token}/pdf`, 'GET', undefined, false, true)).status, 200);
  assert.equal((await request(`/public/quote/${token}/decision`, 'POST', { decision: 'ACCEPTED' }, false)).status, 200);
  assert.equal((await request(`/public/quote/${token}/decision`, 'POST', { decision: 'ACCEPTED' }, false)).status, 200);
  assert.equal((await request(`/public/quote/${token}/decision`, 'POST', { decision: 'DECLINED' }, false)).status, 409);
  assert.equal((await q("SELECT COUNT(*) AS total FROM document_tracking WHERE document_id=? AND event_type='ACCEPTED'", [accepted.id]))[0].total, 1);
  assert.equal((await ok(`/quotes/${accepted.id}`)).status, 'ACCEPTED');
  assert.equal((await ok(`/quotes/${accepted.id}/share`, 'POST', {})).share_url, link.share_url);
  const converted = await request(`/quotes/${accepted.id}/convert-to-invoice`, 'POST', {});
  assert.equal(converted.status, 201);
  await ok(`/invoices/${converted.data.invoice_id}/mark-paid`, 'POST', { amount: 10, payment_date: todayIso(), payment_method: 'BANK_TRANSFER', transaction_reference: 'BANK-123' });
  const ledger = await ok(`/reports/payments-ledger?currency=ZAR&customer_id=${customer.id}&from=${todayIso()}&to=${todayIso()}`);
  assert.equal(ledger.rows.length, 1);
  assert.equal(Number(ledger.rows[0].amount), 10);
  assert.equal(ledger.rows[0].transaction_reference, 'BANK-123');
  assert.equal((await request('/reports/payments-ledger?currency=ZAR&from=2026-12-31&to=2026-01-01')).status, 422);
  assert.equal((await request('/reports/payments-ledger?currency=ZAR&customer_id=999999999')).status, 404);

  const declined = await ok('/quotes', 'POST', { ...payload, request_key: randomUUID() });
  const declinedLink = await ok(`/quotes/${declined.id}/share`, 'POST', {});
  const declinedToken = declinedLink.share_url.split('/').pop();
  assert.equal((await request(`/public/quote/${declinedToken}/decision`, 'POST', { decision: 'DECLINED' }, false)).status, 200);
  assert.equal((await request(`/quotes/${declined.id}/convert-to-invoice`, 'POST', {})).status, 400);
  await ok(`/quotes/${declined.id}/share`, 'DELETE');
  assert.equal((await request(`/public/quote/${declinedToken}`, 'GET', undefined, false)).status, 404);

  const expired = await ok('/quotes', 'POST', { ...payload, request_key: randomUUID() });
  const expiredLink = await ok(`/quotes/${expired.id}/share`, 'POST', {});
  await q("UPDATE documents SET valid_until='2020-01-01' WHERE id=?", [expired.id]);
  const expiredToken = expiredLink.share_url.split('/').pop();
  assert.equal((await ok(`/public/quote/${expiredToken}`, 'GET', undefined, false)).status, 'EXPIRED');
  assert.equal((await request(`/public/quote/${expiredToken}/decision`, 'POST', { decision: 'ACCEPTED' }, false)).status, 410);
  assert.equal((await request(`/quotes/${expired.id}/convert-to-invoice`, 'POST', {})).status, 400);
});
