import { PaymentLedger } from './reports.service';

export function paymentsLedgerCsv(ledger: PaymentLedger): string {
  const lines: (string | number)[][] = [
    ['Date', 'Type', 'Currency', 'Customer', 'Invoice', 'Method', 'Reference', 'Amount'],
    ...ledger.rows.map(row => [row.payment_date, row.kind, ledger.currency_code, row.customer_name, row.document_number, row.payment_method, row.transaction_reference || '', Number(row.amount).toFixed(2)])
  ];
  return '\uFEFF' + lines.map(columns => columns.map(value => {
    const text = String(value ?? '');
    const safe = typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(text) && /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  }).join(',')).join('\r\n') + '\r\n';
}
