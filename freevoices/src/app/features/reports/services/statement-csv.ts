import { CustomerStatement } from './reports.service';

export function customerStatementCsv(statement: CustomerStatement): string {
  const rows = [
    ['Customer', statement.customer_name],
    ['Currency', statement.currency_code],
    ['From', statement.from || 'Beginning'],
    ['To', statement.to],
    [],
    ['Date','Type','Invoice','Debit','Credit','Running balance'],
    ['', 'Opening balance', '', '', '', Number(statement.opening_balance).toFixed(2)],
    ...statement.rows.map(row => [row.day,row.kind,row.document_number,Number(row.debit).toFixed(2),Number(row.credit).toFixed(2),Number(row.balance).toFixed(2)]),
    ['', 'Closing balance', '', '', '', Number(statement.closing_balance).toFixed(2)]
  ];
  return '\uFEFF'+rows.map(values=>values.map(value=>{
    const text=String(value ?? '');
    const safe=!/^-?\d+(?:\.\d+)?$/.test(text) && /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g,'""')}"`;
  }).join(',')).join('\r\n')+'\r\n';
}
