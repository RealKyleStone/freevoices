const { createHash } = require('crypto');

const TEMPLATES = {
  customers: ['name', 'email', 'billing_address', 'phone', 'payment_terms'],
  products: ['name', 'price', 'description', 'vat_inclusive'],
};

function parseCsv(csv) {
  if (typeof csv !== 'string' || !csv.trim()) throw Object.assign(new Error('Choose a CSV file'), { status:422 });
  if (Buffer.byteLength(csv, 'utf8') > 500_000) throw Object.assign(new Error('CSV must be 500 KB or smaller'), { status:422 });
  const rows = [];
  let row = [], field = '', quoted = false;
  const input = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw Object.assign(new Error('CSV has an unclosed quoted field'), { status:422 });
  row.push(field);
  if (row.some(value => value.trim())) rows.push(row);
  return rows;
}

function previewCatalogueCsv(kind, csv) {
  const required = TEMPLATES[kind];
  if (!required) throw Object.assign(new Error('Choose customers or products'), { status:422 });
  const rows = parseCsv(csv);
  if (!rows.length) throw Object.assign(new Error('CSV has no header'), { status:422 });
  const headers = rows[0].map(value => value.trim().toLowerCase());
  if (headers.length !== required.length || required.some((value, index) => headers[index] !== value))
    throw Object.assign(new Error(`Use the ${kind} template header: ${required.join(',')}`), { status:422 });
  if (rows.length > 501) throw Object.assign(new Error('Import at most 500 rows at a time'), { status:422 });
  const seen = new Set();
  const parsed = rows.slice(1).map((values, index) => {
    const errors = [];
    if (values.length !== required.length) errors.push(`Expected ${required.length} columns`);
    const data = Object.fromEntries(required.map((key, n) => [key, String(values[n] ?? '').trim()]));
    if (!data.name || data.name.length > 255) errors.push('Name is required, at most 255 characters');
    const duplicateKey = kind === 'customers' ? data.email.toLowerCase() : data.name.toLowerCase();
    if (duplicateKey && seen.has(duplicateKey)) errors.push(`Duplicate ${kind === 'customers' ? 'email' : 'name'} in file`);
    seen.add(duplicateKey);
    if (kind === 'customers') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) || data.email.length > 255) errors.push('Valid email is required');
      if (!data.billing_address) errors.push('Billing address is required');
      if (data.phone.length > 50) errors.push('Phone must be 50 characters or fewer');
      if (data.payment_terms && (!/^\d+$/.test(data.payment_terms) || Number(data.payment_terms) > 3650)) errors.push('Payment terms must be 0 to 3650 days');
    } else {
      if (!/^\d+(?:\.\d{1,2})?$/.test(data.price) || Number(data.price) > 9999999999999) errors.push('Price must be a non-negative amount with at most two decimals');
      if (!['', 'true', 'false', '1', '0'].includes(data.vat_inclusive.toLowerCase())) errors.push('VAT inclusive must be true or false');
    }
    return { line: index + 2, data, errors };
  });
  return { kind, hash: createHash('sha256').update(csv).digest('hex'), rows: parsed, valid: parsed.length > 0 && parsed.every(row => row.errors.length === 0) };
}

module.exports = { TEMPLATES, parseCsv, previewCatalogueCsv };
