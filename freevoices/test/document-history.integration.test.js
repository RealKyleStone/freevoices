const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { inflateSync } = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

function pdfText(buffer) {
  const raw = buffer.toString('latin1');
  const streams = /<<[^>]*\/Length (\d+)[^>]*>>\s*stream\r?\n/g;
  return [...raw.matchAll(streams)].filter(m => m[0].includes('/FlateDecode') && !m[0].includes('/Subtype /Image'))
    .map(m => inflateSync(buffer.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[1]))).toString())
    .flatMap(s => [...s.matchAll(/<([0-9a-f]+)>/gi)].map(m => Buffer.from(m[1], 'hex').toString('latin1'))).join('');
}

test('issued parties and inclusive pricing survive edits, portal access, receipts and conversion',
  { skip: !process.env.FREEVOICES_TEST_API_URL, timeout: 30000 }, async (t) => {
    const { executeQuery: q, closePool } = require('../src/services/db.service');
    const { todayIso } = require('../src/services/document-math');
    let uid;
    const logo = path.resolve(__dirname, '../uploads/logos', `history-${randomUUID()}.png`);
    t.after(async () => {
      try {
        if (uid) {
          await q('DELETE FROM documents WHERE user_id=?', [uid]);
          await q('DELETE FROM customers WHERE user_id=?', [uid]);
          await q('DELETE FROM products WHERE user_id=?', [uid]);
          await q('DELETE FROM settings WHERE user_id=?', [uid]);
          await q('DELETE FROM security_events WHERE user_id=?', [uid]);
          await q('DELETE FROM data_subject_requests WHERE user_id=?', [uid]);
          await q('DELETE FROM sessions WHERE userId=?', [uid]);
          await q('DELETE FROM users WHERE id=?', [uid]);
        }
        if (fs.existsSync(logo)) fs.unlinkSync(logo);
      } finally { await closePool(); }
    });
    const base = new URL(process.env.FREEVOICES_TEST_API_URL);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
    assert.ok(['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST));
    assert.notEqual(process.env.NODE_ENV, 'production');
    const user = await q('INSERT INTO users(email,company_name,contact_person) VALUES(?,?,?)',
      [`history-${randomUUID()}@example.test`, 'SELLERBEFORE', 'Test Owner']);
    uid = user.insertId;
    const token = randomUUID();
    await q('INSERT INTO sessions(userId,token,expires) VALUES(?,?,?)',
      [uid, createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 3600000)]);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const api = base.href.replace(/\/$/, '');
    async function request(route, method = 'GET', body, pdf = false) {
      const r = await fetch(api + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const data = pdf && r.ok ? Buffer.from(await r.arrayBuffer()) : await r.json();
      return { status: r.status, data };
    }
    async function ok(route, method, body, pdf = false) {
      const r = await request(route, method, body, pdf);
      assert.ok(r.status < 300, `${route}: ${r.status} ${JSON.stringify(r.data)}`);
      return r.data;
    }
    const [currency] = await q("SELECT id FROM currencies WHERE code='ZAR' LIMIT 1");
    assert.ok(currency);
    await ok('/settings/company', 'PUT', { company_name: 'SELLERBEFORE', address: 'SELLERADDRESSBEFORE', vat_number: 'VATBEFORE' });
    await ok('/settings/payment', 'PUT', { bank_name: 'BANKBEFORE', bank_account_number: '123456789', bank_branch_code: '123456' });
    const customer = await ok('/customers', 'POST', { name: 'BUYERBEFORE', email: 'before@example.test', billing_address: 'BUYERADDRESSBEFORE' });
    const product = await ok('/products', 'POST', { name: 'Inclusive product', price: 115, vat_inclusive: true });
    assert.equal(product.vat_inclusive, 1);
    const exclusiveProduct = await ok('/products', 'POST', { name: 'Exclusive product', price: 100, vat_inclusive: 'false' });
    assert.equal(exclusiveProduct.vat_inclusive, 0);
    fs.mkdirSync(path.dirname(logo), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../src/favicon-32x32.png'), logo);
    await q("INSERT INTO settings(user_id,setting_key,setting_value) VALUES(?,'company_logo',?)", [uid, `/uploads/logos/${path.basename(logo)}`]);

    const payload = { customer_id: customer.id, currency_id: currency.id, issue_date: todayIso(),
      items: [{ product_id: product.id, description: 'INCLUSIVEITEM', quantity: 1, unit_price: 115, vat_rate: 15, vat_inclusive: true }] };
    const draft = await ok('/invoices', 'POST', payload);
    assert.deepEqual([draft.subtotal, draft.vat_amount, draft.total], ['100.00', '15.00', '115.00']);
    assert.equal(draft.items[0].vat_inclusive, 1);
    const edited = await ok(`/invoices/${draft.id}`, 'PUT', { ...payload, items: [{ ...payload.items[0], quantity: 2 }] });
    assert.equal(edited.total, '230.00');
    await ok(`/invoices/${draft.id}`, 'PUT', payload);
    const invalid = await request('/invoices', 'POST', { ...payload, items: [{ ...payload.items[0], vat_inclusive: 'invalid' }] });
    assert.equal(invalid.status, 422);

    const firstPdf = await ok(`/invoices/${draft.id}/pdf?markSent=true`, 'GET', undefined, true);
    assert.ok(firstPdf.toString('latin1').includes('/Subtype /Image'), 'Initial PDF includes the logo');
    assert.ok(pdfText(firstPdf).includes('SELLERBEFORE'));
    assert.ok(pdfText(firstPdf).includes('incl. VAT'));
    const [saved] = await q('SELECT payload FROM document_snapshots WHERE document_id=?', [draft.id]);
    assert.ok(saved.payload.startsWith('fv1.'));
    assert.ok(!saved.payload.includes('BUYERBEFORE'));

    // Changes to the live party records and deletion of the old logo cannot
    // change a document already issued to the customer.
    await ok(`/customers/${customer.id}`, 'PUT', { name: 'BUYERAFTER', email: 'after@example.test', billing_address: 'BUYERADDRESSAFTER' });
    await ok('/settings/company', 'PUT', { company_name: 'SELLERAFTER', address: 'SELLERADDRESSAFTER', vat_number: 'VATAFTER' });
    await ok('/settings/payment', 'PUT', { bank_name: 'BANKAFTER', bank_account_number: '987654321', bank_branch_code: '654321' });
    fs.unlinkSync(logo);
    const historical = await ok(`/invoices/${draft.id}`);
    assert.equal(historical.customer_name, 'BUYERBEFORE');
    assert.equal(historical.customer_billing_address, 'BUYERADDRESSBEFORE');
    assert.equal(historical.company_name, 'SELLERBEFORE');
    assert.equal(historical.bank_name, 'BANKBEFORE');
    assert.ok(!('company_logo' in historical), 'Large embedded logos belong in the portal/PDF, not every owner detail/list response');
    const reopened = await ok(`/invoices/${draft.id}/pdf?markSent=true`, 'GET', undefined, true);
    assert.ok(reopened.toString('latin1').includes('/Subtype /Image'), 'Archived logo remains after its file is deleted');
    const reopenedText = pdfText(reopened);
    for (const marker of ['BUYERBEFORE', 'SELLERBEFORE', 'BANKBEFORE', 'BUYERADDRESSBEFORE']) assert.ok(reopenedText.includes(marker), marker);
    assert.ok(!reopenedText.includes('BUYERAFTER'));
    assert.equal((await q('SELECT payload FROM document_snapshots WHERE document_id=?', [draft.id]))[0].payload, saved.payload);
    assert.equal((await request(`/invoices/${draft.id}`, 'PUT', payload)).status, 400);

    const share = await ok(`/invoices/${draft.id}/share`, 'POST', {});
    const portal = await ok(`/public/invoice/${share.token}`);
    assert.equal(portal.customer_name, 'BUYERBEFORE');
    assert.equal(portal.company_name, 'SELLERBEFORE');
    assert.equal(portal.bank_name, 'BANKBEFORE');
    assert.ok(portal.company_logo.startsWith('data:image/png;base64,'));
    assert.ok(!('payfast_merchant_key' in portal));
    assert.ok(!('payload' in portal));
    assert.ok(pdfText(await ok(`/public/invoice/${share.token}/pdf`, 'GET', undefined, true)).includes('SELLERBEFORE'));
    await ok(`/invoices/${draft.id}/mark-paid`, 'POST', { amount: 115, payment_date: todayIso(), payment_method: 'BANK_TRANSFER' });
    assert.ok(pdfText(await ok(`/invoices/${draft.id}/receipt`, 'GET', undefined, true)).includes('SELLERBEFORE'));

    const fresh = await ok('/invoices', 'POST', payload);
    assert.equal((await ok(`/invoices/${fresh.id}`)).customer_name, 'BUYERAFTER');
    // A first payment freezes a draft even while it retains its DRAFT status.
    await ok(`/invoices/${fresh.id}/mark-paid`, 'POST', { amount: 10, payment_date: todayIso(), payment_method: 'BANK_TRANSFER' });
    assert.equal((await request(`/invoices/${fresh.id}`, 'PUT', payload)).status, 400);
    await ok(`/customers/${customer.id}`, 'PUT', { name: 'BUYERLATER', email: 'later@example.test', billing_address: 'BUYERADDRESSLATER' });
    assert.equal((await ok(`/invoices/${fresh.id}`)).customer_name, 'BUYERAFTER');

    const quote = await ok('/quotes', 'POST', payload);
    await ok(`/quotes/${quote.id}`, 'PUT', { ...payload, items: [{ ...payload.items[0], quantity: 2 }] });
    const quoteBefore = await ok(`/quotes/${quote.id}`);
    assert.equal(quoteBefore.total, '230.00');
    await ok(`/quotes/${quote.id}/send`, 'POST', {});
    const converted = await ok(`/quotes/${quote.id}/convert-to-invoice`, 'POST', {});
    const fromQuote = await ok(`/invoices/${converted.invoice_id}`);
    assert.equal(fromQuote.items[0].vat_inclusive, 1);
    assert.equal(fromQuote.total, '230.00');
    await ok(`/customers/${customer.id}`, 'PUT', { name: 'BUYERFINAL', email: 'final@example.test', billing_address: 'BUYERADDRESSFINAL' });
    assert.equal((await ok(`/quotes/${quote.id}`)).customer_name, 'BUYERLATER');
    assert.ok(pdfText(await ok(`/quotes/${quote.id}/pdf`, 'GET', undefined, true)).includes('BUYERLATER'));

    // An edit racing issuance either commits before the issue or is rejected.
    // It must never change the lines after the issued snapshot is saved.
    const race = await ok('/invoices', 'POST', payload);
    const raced = await Promise.all([
      request(`/invoices/${race.id}`, 'PUT', { ...payload, items: [{ ...payload.items[0], quantity: 2 }] }),
      request(`/invoices/${race.id}/pdf?markSent=true`, 'GET', undefined, true),
    ]);
    assert.ok([200, 400].includes(raced[0].status));
    assert.equal(raced[1].status, 200);
    assert.equal((await ok(`/invoices/${race.id}`)).status, 'SENT');
    const value = (await ok(`/invoices/${race.id}`)).total;
    assert.ok(['115.00', '230.00'].includes(value));
    assert.equal((await request(`/invoices/${race.id}`, 'PUT', payload)).status, 400);

    const exported = await ok('/account/export');
    assert.ok(exported.document_snapshots.some(row => row.document_id === draft.id && row.buyer.name === 'BUYERBEFORE'));
    assert.ok(!JSON.stringify(exported.document_snapshots).includes('payfast_merchant_key'));
  });
