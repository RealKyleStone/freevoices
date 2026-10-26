const { todayIso } = require('./document-math');

async function reportCurrency(q, userId, requested, useCompanyDefault = false) {
  let code = requested;
  if (!code && useCompanyDefault) {
    const [row] = await q("SELECT c.code FROM settings s JOIN currencies c ON c.id=CAST(s.setting_value AS UNSIGNED) WHERE s.user_id=? AND s.setting_key='default_currency_id' AND c.is_active=1", [userId]);
    code = row?.code;
  }
  const [currency] = await q('SELECT id,code,symbol FROM currencies WHERE code=? AND is_active=1', [String(code || 'ZAR').toUpperCase()]);
  if (!currency) throw Object.assign(new Error('Choose an active report currency'), { status:422 });
  return currency;
}

async function report(q, userId, requested, kind) {
  const currency = await reportCurrency(q, userId, requested);
  const today = todayIso();
  const queries = {
    revenue: [`SELECT month,SUM(amount) AS revenue FROM (
      SELECT DATE_FORMAT(p.payment_date,'%Y-%m') AS month,p.amount AS amount FROM payments p JOIN documents d ON d.id=p.document_id
      WHERE d.user_id=? AND d.currency_id=? AND d.type='INVOICE' AND p.payment_date>=DATE_SUB(?,INTERVAL 12 MONTH) AND p.payment_date<=?
      UNION ALL
      SELECT DATE_FORMAT(r.refund_date,'%Y-%m') AS month,-r.amount AS amount FROM payment_refunds r JOIN documents d ON d.id=r.invoice_id
      WHERE d.user_id=? AND d.currency_id=? AND d.type='INVOICE' AND r.refund_date>=DATE_SUB(?,INTERVAL 12 MONTH) AND r.refund_date<=?
      ) cash GROUP BY month ORDER BY month`, [userId,currency.id,today,today,userId,currency.id,today,today]],
    status: [`SELECT d.status,COUNT(*) AS count,SUM(d.total-COALESCE(c.credited,0)) AS total FROM documents d
      LEFT JOIN (SELECT invoice_id,SUM(total) AS credited FROM credit_notes GROUP BY invoice_id) c ON c.invoice_id=d.id
      WHERE d.user_id=? AND d.currency_id=? AND d.type='INVOICE' GROUP BY d.status`, [userId,currency.id]],
    customers: [`SELECT c.id AS customer_id,c.name,SUM(cash.amount) AS revenue,COUNT(DISTINCT d.id) AS invoice_count
      FROM (SELECT document_id AS invoice_id,amount FROM payments UNION ALL SELECT invoice_id,-amount FROM payment_refunds) cash
      JOIN documents d ON d.id=cash.invoice_id JOIN customers c ON c.id=d.customer_id
      WHERE d.user_id=? AND d.currency_id=? AND d.type='INVOICE' GROUP BY c.id,c.name ORDER BY revenue DESC LIMIT 5`, [userId,currency.id]],
    vat: [`SELECT month,SUM(subtotal) AS subtotal,SUM(vat_amount) AS vat_amount,SUM(total) AS total FROM (
      SELECT DATE_FORMAT(d.issue_date,'%Y-%m') AS month,d.subtotal,d.vat_amount,d.total
      FROM documents d WHERE d.user_id=? AND d.currency_id=? AND d.type='INVOICE' AND d.status IN ('SENT','OVERDUE','PAID','CREDITED') AND YEAR(d.issue_date)=YEAR(?)
      UNION ALL
      SELECT DATE_FORMAT(cn.issue_date,'%Y-%m') AS month,-cn.subtotal,-cn.vat_amount,-cn.total
      FROM credit_notes cn JOIN documents d ON d.id=cn.invoice_id WHERE d.user_id=? AND d.currency_id=? AND YEAR(cn.issue_date)=YEAR(?)
      ) tax GROUP BY month ORDER BY month`, [userId,currency.id,today,userId,currency.id,today]],
  };
  if (!queries[kind]) throw new Error('Unknown report');
  return (await q(...queries[kind])).map(row => ({ ...row,currency_code:currency.code,currency_symbol:currency.symbol }));
}
module.exports = { reportCurrency, report };
