const test=require('node:test');
const assert=require('node:assert/strict');
const {previewBankCsv}=require('../src/services/bank-import.service');

test('bank CSV reports invalid rows and duplicates before importing',()=>{
  const csv='date,amount,currency,description,reference,transaction_id,account\n2026-10-26,40,ZAR,Deposit,INV-1,TX-1,Bank\n2026-10-26,40,ZAR,Deposit,INV-1,TX-1,Bank\n';
  const preview=previewBankCsv(csv);
  assert.equal(preview.valid,false);
  assert.match(preview.rows[1].errors.join(' '),/Duplicate transaction/);
  assert.equal(preview.rows[1].line,3);
});
