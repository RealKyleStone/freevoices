const { executeQuery, withTransaction } = require('./db.service');
const { lockDocumentOwner, getNextDocumentNumber } = require('./document-number.service');
const { advanceDate } = require('./billing-rules');
const { todayIso, resolveDueDate } = require('./document-math');

// Re-read each occurrence under the same owner/source locks used by document
// creation. Advancing the pointer and inserting the copy commit together.
async function generateOccurrence(userId, sourceId, today = todayIso()) {
  return withTransaction(async q => {
    await lockDocumentOwner(q, userId);
    const [source] = await q(`SELECT d.* FROM documents d JOIN users u ON u.id=d.user_id
      JOIN customers c ON c.id=d.customer_id AND c.user_id=d.user_id
      WHERE d.id=? AND d.user_id=? AND d.type='INVOICE' AND u.status='ACTIVE' AND c.active=1 FOR UPDATE`, [sourceId,userId]);
    if (!source || !source.is_recurring || source.status === 'CANCELLED' || !source.recurrence_next_date || source.recurrence_next_date > today) return null;
    const occurrence = source.recurrence_next_date;
    if (source.recurrence_end_date && occurrence > source.recurrence_end_date) {
      await q('UPDATE documents SET is_recurring=0, recurrence_next_date=NULL WHERE id=?',[source.id]);
      return null;
    }
    const [existing] = await q('SELECT id FROM documents WHERE source_recurring_id=? AND recurrence_occurrence_date=? FOR UPDATE',[source.id,occurrence]);
    let id = existing?.id;
    if (!id) {
      const number = await getNextDocumentNumber(q,userId,'INVOICE');
      const inserted = await q(`INSERT INTO documents(user_id,customer_id,type,document_number,currency_id,status,
        issue_date,due_date,payment_terms,subtotal,vat_amount,total,notes,terms_conditions,purchase_order_ref,delivery_details,delivery_status,source_recurring_id,recurrence_occurrence_date)
        VALUES(?,?,'INVOICE',?,?,'DRAFT',?,?,?,?,?,?,?,?,?,?,'NOT_SENT',?,?)`,
      [userId,source.customer_id,number,source.currency_id,occurrence,resolveDueDate(occurrence,null,source.payment_terms),
        source.payment_terms,source.subtotal,source.vat_amount,source.total,source.notes,source.terms_conditions,source.purchase_order_ref,source.delivery_details,source.id,occurrence]);
      id = inserted.insertId;
      await q(`INSERT INTO document_items(document_id,product_id,description,quantity,unit_label,unit_price,discount_percent,vat_rate,vat_inclusive,vat_amount,subtotal,total)
        SELECT ?,product_id,description,quantity,unit_label,unit_price,discount_percent,vat_rate,vat_inclusive,vat_amount,subtotal,total FROM document_items WHERE document_id=?`,[id,source.id]);
      await q("INSERT INTO document_tracking(document_id,event_type) VALUES(?,'CREATED')",[id]);
    }
    const next = advanceDate(occurrence,source.recurrence_interval,source.recurrence_anchor_date || source.issue_date);
    const ended = !!source.recurrence_end_date && next > source.recurrence_end_date;
    await q('UPDATE documents SET recurrence_next_date=?,is_recurring=? WHERE id=?',[ended ? null : next,ended ? 0 : 1,source.id]);
    return {id,userId,autoSend:!!source.auto_send};
  });
}

async function processRecurring({today=todayIso(),onCreated=async()=>{},onError=()=>{}}={}) {
  const sources = await executeQuery(`SELECT id,user_id FROM documents WHERE type='INVOICE' AND is_recurring=1
    AND recurrence_next_date<=? AND status<>'CANCELLED'`,[today]);
  for (const source of sources) {
    try {
      for (let n=0;n<100;n++) {
        const created = await generateOccurrence(source.user_id,source.id,today);
        if (!created) break;
        await onCreated(created);
      }
    } catch(error) { onError(error,source.id); }
  }
}
module.exports = {generateOccurrence,processRecurring};
