const { roundCents } = require('./document-math');

function money(value, field) {
  if (typeof value !== 'number' && typeof value !== 'string') throw Object.assign(new Error(`${field} must be a money amount`),{status:422});
  const raw = String(value);
  if (!/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(raw)) throw Object.assign(new Error(`${field} must be a non-negative amount with at most two decimals`),{status:422});
  return Number(raw);
}

function validDate(value) {
  return typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
}

function settlement(invoiceTotal, creditTotal, paymentTotal, refundTotal) {
  const adjustedTotal = roundCents(Number(invoiceTotal) - Number(creditTotal));
  const netPaid = roundCents(Number(paymentTotal) - Number(refundTotal));
  const balanceDue = Math.max(0, roundCents(adjustedTotal - netPaid));
  const refundDue = Math.max(0, roundCents(netPaid - adjustedTotal));
  return { adjustedTotal, netPaid, balanceDue, refundDue, settled: balanceDue === 0 };
}

async function invoiceSettlement(q, invoiceId) {
  const [row] = await q(`SELECT d.total,
    (SELECT COALESCE(SUM(total),0) FROM credit_notes WHERE invoice_id=d.id) AS credited,
    (SELECT COALESCE(SUM(amount),0) FROM payments WHERE document_id=d.id) AS paid,
    (SELECT COALESCE(SUM(amount),0) FROM payment_refunds WHERE invoice_id=d.id) AS refunded
    FROM documents d WHERE d.id=?`, [invoiceId]);
  if (!row) return null;
  return { ...settlement(row.total, row.credited, row.paid, row.refunded), creditTotal:Number(row.credited), paymentTotal:Number(row.paid), refundTotal:Number(row.refunded) };
}

module.exports = { money, validDate, settlement, invoiceSettlement };
