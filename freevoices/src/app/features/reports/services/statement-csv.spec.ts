import { customerStatementCsv } from './statement-csv';

describe('customer statement CSV', () => {
  it('shows opening and closing balances with invoice and payment rows', () => {
    const csv = customerStatementCsv({ customer_id: 1, customer_name: '=Danger', currency_code: 'ZAR', from: null, to: '2026-10-26', opening_balance: 0, closing_balance: 105,
      rows: [{ day: '2026-10-26', kind: 'INVOICE', invoice_id: 1, document_number: 'INV-1', debit: 115, credit: 0, balance: 115 },
        { day: '2026-10-26', kind: 'PAYMENT', invoice_id: 1, document_number: 'INV-1', debit: 0, credit: 10, balance: 105 }] });
    expect(csv).toContain('"Customer","\'=Danger"');
    expect(csv).toContain('"","Closing balance","","","","105.00"');
  });
});
