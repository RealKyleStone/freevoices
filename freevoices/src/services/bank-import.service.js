const { createHash } = require('crypto');
const { parseCsv } = require('./catalogue-import.service');

const HEADER = ['date','amount','currency','description','reference','transaction_id','account'];

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
}

function previewBankCsv(csv) {
  const rows = parseCsv(csv);
  if (!rows.length || rows[0].map(v=>v.trim().toLowerCase()).join(',')!==HEADER.join(','))
    throw Object.assign(new Error(`Use the bank template header: ${HEADER.join(',')}`),{status:422});
  if (rows.length>501) throw Object.assign(new Error('Import at most 500 transactions at a time'),{status:422});
  const seen = new Set();
  const parsed = rows.slice(1).map((values,index)=>{
    const errors=[];
    if (values.length!==HEADER.length) errors.push(`Expected ${HEADER.length} columns`);
    const data=Object.fromEntries(HEADER.map((key,n)=>[key,String(values[n] ?? '').trim()]));
    data.currency=data.currency.toUpperCase();
    if (!validDate(data.date)) errors.push('Date must be YYYY-MM-DD');
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(data.amount) || !Number.isFinite(Number(data.amount)) || Number(data.amount)===0 || Math.abs(Number(data.amount))>9999999999999) errors.push('Amount must be a non-zero value with at most two decimals');
    if (!/^[A-Z]{3}$/.test(data.currency)) errors.push('Currency must be a three-letter code');
    if (!data.description && !data.reference) errors.push('Description or reference is required');
    if (data.description.length>1000 || data.reference.length>255 || data.account.length>100 || data.transaction_id.length>100) errors.push('Description, reference, transaction ID or account is too long');
    const identity=data.transaction_id
      ? [data.currency,data.account,data.transaction_id].join('|')
      : [data.date,Number(data.amount).toFixed(2),data.currency,data.account,data.description,data.reference].join('|');
    const source_hash=createHash('sha256').update(identity).digest('hex');
    if (seen.has(source_hash)) errors.push('Duplicate transaction in file');
    seen.add(source_hash);
    return {line:index+2,data,source_hash,errors};
  });
  return {rows:parsed,valid:parsed.length>0 && parsed.every(row=>row.errors.length===0)};
}

module.exports={HEADER,validDate,previewBankCsv};
