const { createHash } = require('crypto');
const { computeDocumentTotals, normaliseTerms, resolveDueDate, addDaysIso } = require('./document-math');

const fail = (message, status = 422) => { throw Object.assign(new Error(message), { status }); };
const boolean = value => [true, 1, '1', 'true'].includes(value);

function advanceDate(current, interval, anchor = current) {
  if (!['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'].includes(interval)) fail('Choose a valid recurring interval');
  if (interval === 'WEEKLY') return addDaysIso(current, 7);
  const [year, month] = current.split('-').map(Number);
  const day = Number(anchor.split('-')[2]);
  const months = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 }[interval];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function requestIdentity(input) {
  const { request_key, ...body } = input;
  if (request_key !== undefined && !/^[A-Za-z0-9:_-]{8,100}$/.test(request_key)) fail('Invalid request key');
  return { key: request_key || null, hash: createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex') };
}

async function prepareDocument(q, userId, type, input) {
  const [customer] = await q('SELECT id, payment_terms FROM customers WHERE id=? AND user_id=? AND active=1', [input.customer_id, userId]);
  if (!customer) fail('Select an active customer from your business');
  const productIds = [...new Set(input.items.map(item => item.product_id).filter(id => id !== null && id !== undefined).map(Number))];
  if (productIds.length) {
    const owned = await q('SELECT id FROM products WHERE id IN (?) AND user_id=? AND is_active=1', [productIds, userId]);
    if (owned.length !== productIds.length) fail('Every product must belong to your business and be active');
  }
  const rows = await q('SELECT setting_key, setting_value FROM settings WHERE user_id=?', [userId]);
  const defaults = Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
  const currencyId = input.currency_id ?? Number(defaults.default_currency_id || 1);
  if (!(await q('SELECT id FROM currencies WHERE id=? AND is_active=1', [currencyId])).length) fail('Select a valid active currency');
  const terms = normaliseTerms(input.payment_terms !== undefined ? input.payment_terms : customer.payment_terms ?? defaults.invoice_payment_terms ?? 30);
  const priced = computeDocumentTotals(input.items.map(item => ({ ...item, vat_rate: item.vat_rate ?? Number(defaults.invoice_vat_rate ?? 15) })));
  const recurring = type === 'INVOICE' && boolean(input.is_recurring);
  if (recurring && !['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'].includes(input.recurrence_interval)) fail('Choose a recurring interval');
  if (recurring && input.recurrence_end_date && input.recurrence_end_date < input.issue_date) fail('Recurring end date cannot precede the issue date');
  return { ...priced, currencyId, payment_terms: terms,
    due_date: resolveDueDate(input.issue_date, input.due_date, terms),
    notes: input.notes !== undefined ? input.notes : defaults.invoice_notes || null,
    terms_conditions: input.terms_conditions || null,
    recurring, interval: recurring ? input.recurrence_interval : null,
    end_date: recurring && input.recurrence_end_date ? input.recurrence_end_date : null,
    auto_send: recurring && boolean(input.auto_send),
  };
}

module.exports = { advanceDate, requestIdentity, prepareDocument, fail, boolean };
