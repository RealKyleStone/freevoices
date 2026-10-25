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
    revenue: [`SELECT DATE_FORMAT(p.payment_date,'%Y-%m') AS month,SUM(p.amount) AS revenue
      FROM payments p JOIN documents d ON d.id=p.document_id
      WHERE d.user_id=? AND d.currency_id=? AND d.type='INVOICE' AND p.payment_date>=DATE_SUB(?,INTERVAL 12 MONTH) AND p.payment_date<=?
      GROUP BY DATE_FORMAT(p.payment_date,'%Y-%m') ORDER BY month`, [userId,currency.id,today,today]],
    status: [`SELECT status,COUNT(*) AS count,SUM(total) AS total FROM documents
      WHERE user_id=? AND currency_id=? AND type='INVOICE' GROUP BY status`, [userId,currency.id]],
    customers: [`SELECT c.id AS customer_id,c.name,SUM(p.amount) AS revenue,COUNT(DISTINCT d.id) AS invoice_count
      FROM payments p JOIN documents d ON d.id=p.document_id JOIN customers c ON c.id=d.customer_id
      WHERE d.user_id=? AND d.currency_id=? AND d.type='INVOICE' GROUP BY c.id,c.name ORDER BY revenue DESC LIMIT 5`, [userId,currency.id]],
    vat: [`SELECT DATE_FORMAT(issue_date,'%Y-%m') AS month,SUM(subtotal) AS subtotal,SUM(vat_amount) AS vat_amount,SUM(total) AS total
      FROM documents WHERE user_id=? AND currency_id=? AND type='INVOICE' AND status IN ('SENT','OVERDUE','PAID') AND YEAR(issue_date)=YEAR(?)
      GROUP BY DATE_FORMAT(issue_date,'%Y-%m') ORDER BY month`, [userId,currency.id,today]],
  };
  if (!queries[kind]) throw new Error('Unknown report');
  return (await q(...queries[kind])).map(row => ({ ...row,currency_code:currency.code,currency_symbol:currency.symbol }));
}
module.exports = { reportCurrency, report };
