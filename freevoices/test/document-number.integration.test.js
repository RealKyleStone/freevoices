const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');

// Opt-in: exercises the running API against a LOCAL database, creating and
// removing only this test's synthetic business. No demo credentials are used.
test('document creation and quote conversion allocate unique numbers under concurrency',
  { skip: !process.env.FREEVOICES_TEST_API_URL, timeout: 30000 }, async (t) => {
    const { executeQuery: q, withTransaction, closePool } = require('../src/services/db.service');
    const { getNextDocumentNumber } = require('../src/services/document-number.service');
    const { todayIso } = require('../src/services/document-math');
    let userId;
    t.after(async () => {
      try {
        if (userId) {
          await q('DELETE FROM documents WHERE user_id = ?', [userId]);
          await q('DELETE FROM customers WHERE user_id = ?', [userId]);
          await q('DELETE FROM sessions WHERE userId = ?', [userId]);
          await q('DELETE FROM users WHERE id = ?', [userId]);
        }
      } finally {
        await closePool();
      }
    });
    const base = new URL(process.env.FREEVOICES_TEST_API_URL);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Local API required');
    assert.ok(['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST), 'Local database required');
    assert.notEqual(process.env.NODE_ENV, 'production');
    const currencies = await q("SELECT id FROM currencies WHERE code = 'ZAR' LIMIT 1");
    assert.ok(currencies.length, 'Seed a local ZAR currency first');
    const user = await q('INSERT INTO users (email, company_name) VALUES (?, ?)',
      [`number-test-${randomUUID()}@example.test`, 'Numbering Regression Test']);
    userId = user.insertId;
    const customer = await q('INSERT INTO customers (user_id, name) VALUES (?, ?)', [userId, 'Concurrency Customer']);
    const token = randomUUID();
    await q('INSERT INTO sessions (userId, token, expires) VALUES (?, ?, ?)',
      [userId, createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 3600000)]);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const payload = { customer_id: customer.insertId, currency_id: currencies[0].id,
      issue_date: todayIso(), items: [{ description: 'Concurrent service', quantity: 1, unit_price: 100, vat_rate: 15 }] };
    async function post(route, body = payload) {
      const response = await fetch(`${base.href.replace(/\/$/, '')}${route}`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }

    const batches = await Promise.all(['invoices', 'quotes'].map(async (type) => {
      const results = await Promise.all(Array.from({ length: 8 }, () => post(`/${type}`)));
      assert.deepEqual(results.map(r => r.status), Array(8).fill(201), JSON.stringify(results));
      assert.equal(new Set(results.map(r => r.body.document_number)).size, 8);
      assert.ok(results.some(r => r.body.document_number.endsWith('-0001')), 'New owner starts its own sequence');
      return results;
    }));

    // A manual invoice and conversion must share a sequence and lock order.
    const mixed = await Promise.all([
      ...batches[1].slice(0, 4).map(r => post(`/quotes/${r.body.id}/convert-to-invoice`, {})),
      ...Array.from({ length: 8 }, () => post('/invoices')),
    ]);
    assert.deepEqual(mixed.map(r => r.status), Array(12).fill(201), JSON.stringify(mixed));
    const twice = await Promise.all(Array.from({ length: 2 }, () => post(`/quotes/${batches[1][4].body.id}/convert-to-invoice`, {})));
    assert.deepEqual(twice.map(r => r.status).sort(), [201, 409]);

    // A transaction with an old repeatable-read snapshot still sees a number
    // committed by another connection while it was open.
    await withTransaction(async (tx) => {
      await tx('SELECT id FROM documents WHERE user_id = ?', [userId]);
      const created = await post('/invoices');
      assert.equal(created.status, 201);
      const next = await getNextDocumentNumber(tx, userId, 'INVOICE');
      assert.equal(BigInt(next.split('-')[2]), BigInt(created.body.document_number.split('-')[2]) + 1n);
    });

    let rolledBackNumber;
    await assert.rejects(withTransaction(async (tx) => {
      rolledBackNumber = await getNextDocumentNumber(tx, userId, 'INVOICE');
      await tx(`INSERT INTO documents (user_id, customer_id, type, document_number, currency_id, issue_date, subtotal, vat_amount, total)
        VALUES (?, ?, 'INVOICE', ?, ?, ?, 0, 0, 0)`,
      [userId, customer.insertId, rolledBackNumber, currencies[0].id, todayIso()]);
      throw new Error('Rollback numbering fixture');
    }), /Rollback numbering fixture/);
    const afterRollback = await post('/invoices');
    assert.equal(afterRollback.status, 201);
    assert.equal(afterRollback.body.document_number, rolledBackNumber);

    // Imported/out-of-order rows must not restart the sequence, and padding
    // must not break when an established business reaches invoice 10,000.
    const year = todayIso().slice(0, 4);
    for (const suffix of ['9999', '0999']) {
      await q(`INSERT INTO documents (user_id, customer_id, type, document_number, currency_id, issue_date, subtotal, vat_amount, total)
        VALUES (?, ?, 'INVOICE', ?, ?, ?, 0, 0, 0)`,
      [userId, customer.insertId, `INV-${year}-${suffix}`, currencies[0].id, todayIso()]);
    }
    const afterImport = await post('/invoices');
    assert.equal(afterImport.status, 201);
    assert.equal(afterImport.body.document_number, `INV-${year}-10000`);
    const rows = await q('SELECT type, document_number FROM documents WHERE user_id = ?', [userId]);
    assert.equal(new Set(rows.map(r => `${r.type}:${r.document_number}`)).size, rows.length);
  });
