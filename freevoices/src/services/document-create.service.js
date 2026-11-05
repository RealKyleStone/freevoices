const { withTransaction, executeQuery } = require('./db.service');
const { getNextDocumentNumber, lockDocumentOwner } = require('./document-number.service');
const { prepareDocument, requestIdentity, advanceDate, fail } = require('./billing-rules');

async function createDocument(userId, type, input) {
  const identity = requestIdentity(input);
  const result = await withTransaction(async q => {
    await lockDocumentOwner(q, userId);
    if (identity.key) {
      const [existing] = await q('SELECT id, request_hash FROM documents WHERE user_id=? AND type=? AND request_key=? FOR UPDATE', [userId, type, identity.key]);
      if (existing) {
        if (existing.request_hash !== identity.hash) fail('This request key was already used for different content', 409);
        return { id: existing.id, replayed: true };
      }
    }
    const data = await prepareDocument(q, userId, type, input);
    const number = await getNextDocumentNumber(q, userId, type);
    const inserted = await q(`INSERT INTO documents
      (user_id, customer_id, type, document_number, currency_id, status, issue_date, due_date, valid_until,
       payment_terms, subtotal, vat_amount, total, notes, terms_conditions, purchase_order_ref, delivery_details, is_recurring, recurrence_interval,
       recurrence_next_date, recurrence_end_date, recurrence_anchor_date, auto_send, delivery_status, request_key, request_hash)
      VALUES (?,?,?,?,?,'DRAFT',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'NOT_SENT',?,?)`,
    [userId, input.customer_id, type, number, data.currencyId, input.issue_date,
      type === 'INVOICE' ? data.due_date : null, type === 'QUOTE' ? input.valid_until || null : null,
      data.payment_terms, data.subtotal.toFixed(2), data.vat_amount.toFixed(2), data.total.toFixed(2),
      data.notes, data.terms_conditions, input.purchase_order_ref || null, input.delivery_details || null, data.recurring ? 1 : 0, data.interval,
      data.recurring ? advanceDate(input.issue_date, data.interval) : null, data.end_date,
      data.recurring ? input.issue_date : null, data.auto_send ? 1 : 0, identity.key, identity.key ? identity.hash : null]);
    for (const item of data.lines) {
      await q(`INSERT INTO document_items (document_id, product_id, description, quantity, unit_label, unit_price, discount_percent, vat_rate, vat_inclusive, vat_amount, subtotal, total)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [inserted.insertId, item.product_id || null, item.description, item.quantity, item.unit_label,
        item.unit_price, item.discount_percent, item.vat_rate, item.vat_inclusive ? 1 : 0, item.vat_amount.toFixed(2), item.subtotal.toFixed(2), item.total.toFixed(2)]);
    }
    await q("INSERT INTO document_tracking(document_id,event_type) VALUES(?,'CREATED')", [inserted.insertId]);
    return { id: inserted.insertId, replayed: false };
  });
  const [document] = await executeQuery('SELECT d.*, c.name AS customer_name FROM documents d JOIN customers c ON c.id=d.customer_id WHERE d.id=? AND d.user_id=?', [result.id, userId]);
  const items = await executeQuery('SELECT * FROM document_items WHERE document_id=? ORDER BY id', [result.id]);
  return { ...document, items, replayed: result.replayed };
}

module.exports = { createDocument };
