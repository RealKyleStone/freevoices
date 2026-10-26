const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { inflateSync } = require('node:zlib');

function pdfText(buffer) {
  const raw = buffer.toString('latin1');
  return [...raw.matchAll(/<<[^>]*\/Length (\d+)[^>]*>>\s*stream\r?\n/g)]
    .filter(m => m[0].includes('/FlateDecode') && !m[0].includes('/Subtype /Image'))
    .map(m => inflateSync(buffer.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[1]))).toString())
    .flatMap(s => [...s.matchAll(/<([0-9a-f]+)>/gi)].map(m => Buffer.from(m[1], 'hex').toString('latin1'))).join('');
}

test('units, discounts and customer references persist through edit, PDF, conversion and recurrence',
  { skip: !process.env.FREEVOICES_TEST_API_URL, timeout: 30000 }, async t => {
    const { executeQuery: q, closePool } = require('../src/services/db.service');
    const { todayIso } = require('../src/services/document-math');
    const { generateOccurrence } = require('../src/services/recurring.service');
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
    uid = (await q('INSERT INTO users(email,company_name) VALUES(?,?)', [`fields-${randomUUID()}@example.test`, 'Field test'])).insertId;
    const token = randomUUID();
    await q('INSERT INTO sessions(userId,token,expires) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))', [uid, createHash('sha256').update(token).digest('hex')]);
    const base = process.env.FREEVOICES_TEST_API_URL.replace(/\/$/, '');
    const request = async (route, method = 'GET', body, pdf = false) => {
      const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = pdf && response.ok ? Buffer.from(await response.arrayBuffer()) : await response.json();
      return { status: response.status, data };
    };
    const ok = async (...args) => { const r = await request(...args); assert.ok(r.status < 300, `${args[0]}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
    const customer = await ok('/customers', 'POST', { name: 'Field buyer', email: 'fields@example.test', billing_address: 'Test address' });
    const currency = (await q("SELECT id FROM currencies WHERE code='ZAR'"))[0].id;
    const line = { description: 'Consulting', quantity: 2, unit_label: 'hours', unit_price: 115, discount_percent: 10, vat_rate: 15, vat_inclusive: true };
    const payload = { customer_id: customer.id, currency_id: currency, issue_date: todayIso(), payment_terms: 0,
      purchase_order_ref: 'PO-123', delivery_details: 'Remote delivery', items: [line] };
    const preview = pdfText(await ok('/invoices/preview', 'POST', payload, true));
    assert.ok(preview.includes('PREVIEW'));
    assert.ok(preview.includes(Number(207).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
    assert.equal((await q('SELECT COUNT(*) AS total FROM documents WHERE user_id=?', [uid]))[0].total, 0);
    assert.equal((await request('/invoices', 'POST', { ...payload, items: [{ ...line, discount_percent: 101 }] })).status, 422);
    assert.equal((await request('/invoices', 'POST', { ...payload, items: [{ ...line, unit_label: 'x'.repeat(21) }] })).status, 422);
    const invoice = await ok('/invoices', 'POST', payload);
    assert.deepEqual([invoice.subtotal, invoice.vat_amount, invoice.total], ['180.00', '27.00', '207.00']);
    assert.equal(invoice.items[0].unit_label, 'hours');
    assert.equal(Number(invoice.items[0].discount_percent), 10);
    const edited = await ok(`/invoices/${invoice.id}`, 'PUT', { ...payload, items: [{ ...line, discount_percent: 20 }] });
    assert.deepEqual([edited.subtotal, edited.vat_amount, edited.total], ['160.00', '24.00', '184.00']);
    const invoiceText = pdfText(await ok(`/invoices/${invoice.id}/pdf`, 'GET', undefined, true));
    for (const marker of ['PO-123', 'Remote delivery', 'Unit: hours', 'Discount: 20%']) assert.ok(invoiceText.includes(marker), marker);

    const quote = await ok('/quotes', 'POST', payload);
    const converted = await ok(`/quotes/${quote.id}/convert-to-invoice`, 'POST', {});
    const fromQuote = await ok(`/invoices/${converted.invoice_id}`);
    assert.equal(fromQuote.purchase_order_ref, 'PO-123');
    assert.equal(fromQuote.delivery_details, 'Remote delivery');
    assert.equal(fromQuote.total, '207.00');
    assert.equal(fromQuote.items[0].unit_label, 'hours');
    assert.equal(Number(fromQuote.items[0].discount_percent), 10);

    const recurring = await ok('/invoices', 'POST', { ...payload, is_recurring: true, recurrence_interval: 'MONTHLY' });
    const next = (await q("SELECT DATE_FORMAT(recurrence_next_date,'%Y-%m-%d') AS day FROM documents WHERE id=?", [recurring.id]))[0].day;
    const occurrence = await generateOccurrence(uid, recurring.id, next);
    assert.ok(occurrence?.id);
    const copy = await ok(`/invoices/${occurrence.id}`);
    assert.equal(copy.purchase_order_ref, 'PO-123');
    assert.equal(copy.delivery_details, 'Remote delivery');
    assert.equal(copy.total, '207.00');
    assert.equal(copy.items[0].unit_label, 'hours');
    assert.equal(Number(copy.items[0].discount_percent), 10);
  });
