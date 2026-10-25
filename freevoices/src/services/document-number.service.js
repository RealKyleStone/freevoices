const { todayIso } = require('./document-math');

// Always acquire this lock before locking a source quote. All document writers
// use the same order, so conversion and manual creation cannot deadlock over it.
async function lockDocumentOwner(q, userId) {
  const owners = await q('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (!owners.length) throw new Error('Document owner not found');
}

/** Allocate and insert on the SAME transaction/connection, holding the owner
 * lock until commit. A locking read sees the latest committed number even if
 * the transaction established an older repeatable-read snapshot beforehand.
 */
async function getNextDocumentNumber(q, userId, type) {
  if (!['INVOICE', 'QUOTE'].includes(type)) throw new Error('Invalid document type');
  await lockDocumentOwner(q, userId);
  const settings = type === 'INVOICE'
    ? await q("SELECT setting_key, setting_value FROM settings WHERE user_id=? AND setting_key IN ('invoice_prefix','invoice_next_number')", [userId]) : [];
  const defaults = Object.fromEntries(settings.map(row => [row.setting_key, row.setting_value]));
  const prefix = type === 'INVOICE' ? defaults.invoice_prefix || 'INV' : 'QUO';
  if (!/^[A-Z0-9]{1,12}$/.test(prefix)) throw new Error('Invalid invoice prefix');
  const year = todayIso().slice(0, 4);
  const rows = await q(
    `SELECT document_number FROM documents
      WHERE user_id = ? AND type = ? AND document_number REGEXP ?
      ORDER BY CAST(SUBSTRING_INDEX(document_number, '-', -1) AS UNSIGNED) DESC
      LIMIT 1 FOR UPDATE`,
    [userId, type, `^${prefix}-${year}-[0-9]+$`]
  );
  const minimum = BigInt(defaults.invoice_next_number || 1);
  const following = rows.length ? BigInt(rows[0].document_number.split('-')[2]) + 1n : 1n;
  const sequence = following > minimum ? following : minimum;
  return `${prefix}-${year}-${String(sequence).padStart(4, '0')}`;
}

module.exports = { getNextDocumentNumber, lockDocumentOwner };
