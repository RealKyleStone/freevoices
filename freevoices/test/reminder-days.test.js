const test=require('node:test');
const assert=require('node:assert/strict');
const {parseReminderDays}=require('../src/services/billing-notifications.service');

test('reminder timing is ordered and bounded',async t=>{
  t.after(()=>require('../src/services/db.service').closePool());
  assert.deepEqual(parseReminderDays('14,1,7'),[1,7,14]);
  assert.deepEqual(parseReminderDays(undefined),[1,7,14]);
  for(const value of ['0,7','1,1','366','1,2,3,4,5,6','not-a-day'])
    assert.throws(()=>parseReminderDays(value));
});
