import { VatSummaryRow } from './reports.service';

/** Export the figures shown on screen, with their accounting basis explicit. */
export function vatSummaryCsv(rows: VatSummaryRow[], currency: string): string {
  const lines = [
    ['Month', 'Currency', 'Basis', 'Subtotal', 'Output VAT', 'Total'],
    ...rows.map(row => [row.month, currency, 'Issued invoices by issue month', Number(row.subtotal).toFixed(2), Number(row.vat_amount).toFixed(2), Number(row.total).toFixed(2)])
  ];
  return '\uFEFF' + lines.map(columns => columns.map(value => {
    const text = String(value ?? '');
    // Keep spreadsheet applications from interpreting any imported text as a formula.
    const safe = typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(text) && /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  }).join(',')).join('\r\n') + '\r\n';
}
