const test=require('node:test');
const assert=require('node:assert/strict');
const {advanceDate,requestIdentity,prepareDocument}=require('../src/services/billing-rules');

test('recurrences retain their original day across short months and leap years',()=>{
  assert.equal(advanceDate('2026-01-31','MONTHLY'),'2026-02-28');
  assert.equal(advanceDate('2026-02-28','MONTHLY','2026-01-31'),'2026-03-31');
  assert.equal(advanceDate('2026-11-30','QUARTERLY'),'2027-02-28');
  assert.equal(advanceDate('2027-02-28','QUARTERLY','2026-11-30'),'2027-05-30');
  assert.equal(advanceDate('2024-02-29','YEARLY'),'2025-02-28');
  assert.equal(advanceDate('2027-02-28','YEARLY','2024-02-29'),'2028-02-29');
  assert.equal(advanceDate('2026-12-29','WEEKLY'),'2027-01-05');
  assert.throws(()=>advanceDate('2026-01-31',null),/interval/);
});
test('request identity is stable across object key order but detects changed content',()=>{
  const a=requestIdentity({request_key:'request-123',a:1,b:{c:3,d:4}});
  assert.equal(a.hash,requestIdentity({b:{d:4,c:3},a:1,request_key:'request-123'}).hash);
  assert.notEqual(a.hash,requestIdentity({a:2,b:{c:3,d:4}}).hash);
  assert.throws(()=>requestIdentity({request_key:'bad key!'}),/request key/);
});
test('business defaults apply while explicit zero terms and VAT remain valid',async()=>{
  const q=async sql=>sql.includes('FROM customers')?[{id:1,payment_terms:null}]:sql.includes('FROM settings')?
    [{setting_key:'invoice_payment_terms',setting_value:'14'},{setting_key:'invoice_vat_rate',setting_value:'0'},{setting_key:'invoice_notes',setting_value:'Thank you'}]:[{id:1}];
  const input={customer_id:1,issue_date:'2026-10-24',items:[{description:'Work',quantity:1,unit_price:100}]};
  const doc=await prepareDocument(q,1,'INVOICE',input);
  assert.equal(doc.payment_terms,14);assert.equal(doc.due_date,'2026-11-07');
  assert.equal(doc.total,100);assert.equal(doc.notes,'Thank you');
  const immediate=await prepareDocument(q,1,'INVOICE',{...input,payment_terms:0,notes:''});
  assert.equal(immediate.due_date,'2026-10-24');assert.equal(immediate.notes,'');
});
