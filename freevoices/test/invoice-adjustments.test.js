const test = require('node:test');
const assert = require('node:assert/strict');
const { money, validDate, settlement } = require('../src/services/invoice-adjustments.service');

test('settlement separates outstanding balance from money owed back', () => {
  assert.deepEqual(settlement(115, 0, 40, 0), { adjustedTotal:115, netPaid:40, balanceDue:75, refundDue:0, settled:false });
  assert.deepEqual(settlement(115, 50, 115, 0), { adjustedTotal:65, netPaid:115, balanceDue:0, refundDue:50, settled:true });
  assert.deepEqual(settlement(115, 50, 115, 50), { adjustedTotal:65, netPaid:65, balanceDue:0, refundDue:0, settled:true });
  assert.deepEqual(settlement(115, 50, 115, 70), { adjustedTotal:65, netPaid:45, balanceDue:20, refundDue:0, settled:false });
});

test('refund dates must be real calendar dates',()=>{
  assert.equal(validDate('2026-10-26'),true);
  assert.equal(validDate('2026-02-30'),false);
  assert.equal(validDate('2026-10-26T00:00:00Z'),false);
});

test('adjustment amounts require exact cents and finite non-negative values', () => {
  assert.equal(money('12.30','Amount'),12.3);
  for (const invalid of [-1,'1.001','1e3','01.00','NaN',null,Infinity]) {
    assert.throws(() => money(invalid,'Amount'));
  }
});
