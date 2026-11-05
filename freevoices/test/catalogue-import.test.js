const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, previewCatalogueCsv } = require('../src/services/catalogue-import.service');

test('CSV parser preserves quoted commas and newlines', () => {
  assert.deepEqual(parseCsv('name,email\r\n"Smith, Ltd","a@example.test"\r\n"Line\nBreak",b@example.test\n'), [
    ['name','email'], ['Smith, Ltd','a@example.test'], ['Line\nBreak','b@example.test']
  ]);
});

test('catalogue preview reports row numbers and duplicate errors without saving', () => {
  const csv = 'name,email,billing_address,phone,payment_terms\nA,a@example.test,Street,,0\nB,a@example.test,Street,,0\n';
  const preview = previewCatalogueCsv('customers',csv);
  assert.equal(preview.valid,false);
  assert.equal(preview.rows[1].line,3);
  assert.match(preview.rows[1].errors.join(' '),/Duplicate email/);
});
