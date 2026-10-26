import { vatSummaryCsv } from './vat-csv';

describe('VAT summary CSV', () => {
  it('exports the visible currency and amounts with an explicit basis', () => {
    const csv = vatSummaryCsv([{ month: '2026-10', subtotal: 180, vat_amount: 27, total: 207 }], 'ZAR');
    expect(csv).toContain('"Month","Currency","Basis","Subtotal","Output VAT","Total"');
    expect(csv).toContain('"2026-10","ZAR","Issued invoices by issue month","180","27","207"');
  });

  it('escapes spreadsheet formulas in text fields', () => {
    const csv = vatSummaryCsv([{ month: '=1+1', subtotal: 0, vat_amount: 0, total: 0 }], 'ZAR');
    expect(csv).toContain('"\'=1+1"');
  });
});
