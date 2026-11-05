import { paymentsLedgerCsv } from './payments-ledger-csv';

describe('payment ledger CSV', () => {
  it('exports only the selected payment rows and protects text from formulas', () => {
    const csv = paymentsLedgerCsv({ currency_code: 'ZAR', from: null, to: null, rows: [{
      id: 1, kind: 'PAYMENT', payment_date: '2026-10-26', amount: 10, payment_method: 'BANK_TRANSFER', transaction_reference: '=1+1',
      invoice_id: 1, document_number: 'INV-1', customer_id: 1, customer_name: 'Smith, Ltd'
    }] });
    expect(csv).toContain('"2026-10-26","PAYMENT","ZAR","Smith, Ltd","INV-1","BANK_TRANSFER","\'=1+1","10.00"');
  });
});
