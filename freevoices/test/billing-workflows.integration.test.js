const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');

test('billing workflows enforce ownership, idempotency, delivery, currencies and schedule recovery',
  {skip:!process.env.FREEVOICES_TEST_API_URL,timeout:60000},async t=>{
  const base=new URL(process.env.FREEVOICES_TEST_API_URL);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(base.hostname));
  const {executeQuery:q,closePool,withTransaction}=require('../src/services/db.service');
  const {queueEmail,deliverEmail,processOutbox}=require('../src/services/outbox.service');
  const {generateOccurrence,processRecurring}=require('../src/services/recurring.service');
  const {processBillingNotifications}=require('../src/services/billing-notifications.service');
  const {todayIso}=require('../src/services/document-math');
  const {decryptField,hashToken}=require('../src/services/encrypted-fields');
  const argon2=require('argon2');
  const ids=[];
  t.after(async()=>{
    try {for(const id of ids){
      await q('DELETE FROM documents WHERE user_id=?',[id]);
      await q('DELETE FROM email_outbox WHERE user_id=?',[id]);
      await q('DELETE FROM customers WHERE user_id=?',[id]);
      await q('DELETE FROM products WHERE user_id=?',[id]);
      await q('DELETE FROM settings WHERE user_id=?',[id]);
      await q('DELETE FROM security_events WHERE user_id=?',[id]);
      await q('DELETE FROM password_reset_tokens WHERE user_id=?',[id]);
      await q('DELETE FROM sessions WHERE userId=?',[id]);
      await q('DELETE FROM users WHERE id=?',[id]);
    }}finally{await closePool();}
  });
  const token=randomUUID(),email=`workflow-${randomUUID()}@example.test`,password='WorkflowTest2026!';
  const uid=(await q("INSERT INTO users(email,password_hash,email_verified,company_name) VALUES(?,?,1,'WORKFLOW TEST')",[email,await argon2.hash(password)])).insertId;ids.push(uid);
  const other=(await q('INSERT INTO users(email,email_verified) VALUES(?,1)',[`other-${randomUUID()}@example.test`])).insertId;ids.push(other);
  await q('INSERT INTO sessions(userId,token,expires) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))',[uid,hashToken(token)]);
  for(const key of ['notify_invoice_sent','notify_payment_received','notify_invoice_overdue']) await q('INSERT INTO settings(user_id,setting_key,setting_value) VALUES(?,?,0)',[uid,key]);
  const request=async(route,method='GET',body)=>{
    const response=await fetch(base.href.replace(/\/$/,'')+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const ok=async(route,method,body)=>{const r=await request(route,method,body);assert.ok(r.status<300,`${route}: ${r.status} ${JSON.stringify(r.data)}`);return r.data;};
  const zar=(await q("SELECT id FROM currencies WHERE code='ZAR'"))[0].id;
  const usd=(await q("SELECT id FROM currencies WHERE code='USD'"))[0].id;
  const customer=await ok('/customers','POST',{name:'Workflow buyer',email:'buyer@example.test',billing_address:'Test address'});
  await q('UPDATE customers SET payment_terms=NULL WHERE id=?',[customer.id]);
  const foreignProduct=(await q("INSERT INTO products(user_id,name,price) VALUES(?,'Other business',100)",[other])).insertId;
  const defaults={invoice_prefix:'TEST',invoice_next_number:500,invoice_payment_terms:14,invoice_vat_rate:0,invoice_notes:'Default note',default_currency_id:zar};
  const payload={customer_id:customer.id,issue_date:todayIso(),items:[{description:'Consulting',quantity:1,unit_price:100}]};
  let invoice;
  await t.test('transactions recover from a real database deadlock without duplicating writes',async()=>{
    let ready=0,release;
    const barrier=new Promise(resolve=>{release=resolve;});
    const calls=[0,0];
    const worker=(index,first,second)=>withTransaction(async tx=>{
      calls[index]++;
      await tx('SELECT id FROM users WHERE id=? FOR UPDATE',[first]);
      if(calls[index]===1) {ready++;if(ready===2) release();await barrier;}
      await tx('SELECT id FROM users WHERE id=? FOR UPDATE',[second]);
      await tx("INSERT INTO settings(user_id,setting_key,setting_value) VALUES(?,?,'committed')",[uid,`deadlock-${index}`]);
    });
    await Promise.all([worker(0,uid,other),worker(1,other,uid)]);
    assert.ok(calls.some(n=>n>1));
    assert.equal((await q("SELECT setting_key FROM settings WHERE user_id=? AND setting_key LIKE 'deadlock-%'",[uid])).length,2);
  });
  await t.test('defaults, numbering floor and concurrent idempotent create',async()=>{
    await ok('/settings/invoice','PUT',defaults);
    const invalid=await request('/settings/invoice','PUT',{...defaults,invoice_prefix:'bad-prefix'});assert.equal(invalid.status,422);
    const key=randomUUID();
    const responses=await Promise.all(Array.from({length:5},()=>ok('/invoices','POST',{...payload,request_key:key})));
    assert.equal(new Set(responses.map(r=>r.id)).size,1);
    invoice=responses[0];
    assert.match(invoice.document_number,/-0500$/);assert.equal(invoice.payment_terms,14);assert.equal(invoice.total,'100.00');assert.equal(invoice.notes,'Default note');
    assert.equal((await request('/invoices','POST',{...payload,notes:'Changed',request_key:key})).status,409);
    await q('UPDATE customers SET payment_terms=0 WHERE id=?',[customer.id]);
    const immediate=await ok('/quotes','POST',payload);assert.equal(immediate.payment_terms,0);
    assert.equal((await request('/invoices','POST',{...payload,is_recurring:true})).status,422);
  });
  await t.test('foreign products rejected on create and edit',async()=>{
    const bad={...payload,items:[{...payload.items[0],product_id:foreignProduct}]};
    assert.equal((await request('/invoices','POST',bad)).status,422);
    assert.equal((await request('/quotes','POST',bad)).status,422);
    assert.equal((await request(`/invoices/${invoice.id}`,'PUT',bad)).status,422);
  });
  await t.test('catalogue search and pagination include records beyond 100 without crossing businesses',async()=>{
    const customers=Array.from({length:107},(_,i)=>[uid,'M2CAT customer',`m2.${i}@example.test`,'Synthetic address']);
    const products=Array.from({length:107},(_,i)=>[uid,'M2CAT product',`M2SKU${i}`,115,1]);
    await q('INSERT INTO customers(user_id,name,email,billing_address) VALUES ?',[customers]);
    await q('INSERT INTO products(user_id,name,description,price,vat_inclusive) VALUES ?',[products]);
    await q("INSERT INTO customers(user_id,name,email) VALUES(?,'M2CAT customer','m2.106@example.test')",[other]);
    await q("INSERT INTO products(user_id,name,description,price) VALUES(?,'M2CAT product','M2SKU106',100)",[other]);
    for(const resource of ['customers','products']) {
      const ids=[];
      for(let page=1;page<=6;page++) {
        const rows=await ok(`/${resource}?search=M2CAT&page=${page}&limit=20`);
        assert.equal(rows.total,107);ids.push(...rows.data.map(row=>row.id));
        assert.ok(rows.data.every(row=>row.user_id===uid));
      }
      assert.equal(new Set(ids).size,107);assert.deepEqual(ids,[...ids].sort((a,b)=>a-b));
    }
    const foundCustomer=await ok('/customers?search=m2.106%40example.test');
    assert.equal(foundCustomer.total,1);assert.equal(foundCustomer.data[0].user_id,uid);
    const lightweight=await ok(`/customers/${foundCustomer.data[0].id}?include_documents=false`);
    assert.equal(lightweight.id,foundCustomer.data[0].id);assert.ok(!('documents' in lightweight));
    const foundProduct=await ok('/products?search=M2SKU106');
    assert.equal(foundProduct.total,1);assert.equal(foundProduct.data[0].user_id,uid);
    assert.equal(foundProduct.data[0].vat_inclusive,1);
  });
  await t.test('share link reuse, explicit rotation and revocation',async()=>{
    const first=await ok(`/invoices/${invoice.id}/share`,'POST',{});
    const reused=await ok(`/invoices/${invoice.id}/share`,'POST',{});
    assert.equal(first.token,reused.token);assert.equal(first.expires_at,reused.expires_at);
    const rotated=await ok(`/invoices/${invoice.id}/share`,'POST',{rotate:true});assert.notEqual(rotated.token,first.token);
    const stored=(await q('SELECT payload FROM document_share_links WHERE document_id=?',[invoice.id]))[0].payload;
    assert.ok(stored.startsWith('fv1.'));assert.equal(decryptField('document_share_links','payload',stored),rotated.token);
    await ok(`/invoices/${invoice.id}/share`,'DELETE');
    assert.equal((await q('SELECT share_token FROM documents WHERE id=?',[invoice.id]))[0].share_token,null);
  });
  await t.test('payments block cancellation and reports separate currencies',async()=>{
    await ok(`/invoices/${invoice.id}/mark-paid`,'POST',{amount:40,payment_date:todayIso(),payment_method:'BANK_TRANSFER'});
    assert.equal((await request(`/invoices/${invoice.id}/cancel`,'POST',{})).status,400);
    const dollar=await ok('/invoices','POST',{...payload,currency_id:usd});
    await ok(`/invoices/${dollar.id}/mark-paid`,'POST',{amount:20,payment_date:todayIso(),payment_method:'BANK_TRANSFER'});
    const rand=await ok('/reports/revenue-by-month?currency=ZAR');
    const dollars=await ok('/reports/revenue-by-month?currency=USD');
    assert.equal(Number(rand[0].revenue),40);assert.equal(Number(dollars[0].revenue),20);
    assert.equal(rand[0].currency_code,'ZAR');
    const zarSummary=await ok('/dashboard/summary');
    assert.equal(zarSummary.monthRevenue,40);
    assert.equal(zarSummary.outstanding,60);
    assert.equal(zarSummary.ageing.current,60);
    assert.equal(zarSummary.actionInvoices.find(row=>row.id===invoice.id).balance_due,60);
    const usdSummary=await ok('/dashboard/summary?currency=USD');
    assert.equal(usdSummary.monthRevenue,20);
    assert.equal(usdSummary.outstanding,80);
    const originalDue=(await q("SELECT DATE_FORMAT(due_date,'%Y-%m-%d') AS due FROM documents WHERE id=?",[invoice.id]))[0].due;
    try {
      await q('UPDATE documents SET due_date=DATE_SUB(?,INTERVAL 40 DAY) WHERE id=?',[todayIso(),invoice.id]);
      const aged=await ok('/dashboard/summary');
      assert.equal(aged.ageing.days31to60,60);
      assert.equal(aged.ageing.current,0);
    } finally { await q('UPDATE documents SET due_date=? WHERE id=?',[originalDue,invoice.id]); }
  });
  await t.test('outbox persists, retries, de-duplicates and refuses ambiguous automatic resend',async()=>{
    let calls=0;
    const accepted={sendMail:async()=>{calls++;return {accepted:['buyer@example.test'],rejected:[]};}};
    const mail={to:'buyer@example.test',subject:'Test',text:'Test',attachments:[{filename:'test.pdf',content:Buffer.from('PDF')} ]};
    const args={userId:uid,documentId:invoice.id,kind:'INVOICE',key:'test-delivery',mail};
    const job=await queueEmail(args);assert.equal((await queueEmail(args)).id,job.id);
    const raw=(await q('SELECT payload FROM email_outbox WHERE id=?',[job.id]))[0].payload;assert.ok(raw.startsWith('fv1.'));
    assert.equal((await deliverEmail(job.id,{sendMail:async()=>{throw Object.assign(new Error('offline'),{code:'ECONNREFUSED'});}})).status,'FAILED');
    const outcomes=await Promise.all([deliverEmail(job.id,accepted,{retry:true}),deliverEmail(job.id,accepted,{retry:true})]);
    assert.equal(calls,1);assert.ok(outcomes.some(r=>r.status==='ACCEPTED'));
    assert.equal((await q('SELECT delivery_status FROM documents WHERE id=?',[invoice.id]))[0].delivery_status,'ACCEPTED');
    const ambiguous=await queueEmail({...args,key:'ambiguous'});
    assert.equal((await deliverEmail(ambiguous.id,{sendMail:async()=>{throw Object.assign(new Error('timeout'),{command:'DATA'});}})).status,'UNCERTAIN');
    await deliverEmail(ambiguous.id,accepted,{retry:true});assert.equal(calls,1);
    const crashed=await queueEmail({...args,key:'crashed'});
    await q("UPDATE email_outbox SET status='SENDING',lease_until=DATE_SUB(NOW(),INTERVAL 1 MINUTE) WHERE id=?",[crashed.id]);
    await processOutbox(accepted);assert.equal((await q('SELECT status FROM email_outbox WHERE id=?',[crashed.id]))[0].status,'UNCERTAIN');
  });
  await t.test('concurrent recurring workers preserve anchored dates and recover missed occurrences',async()=>{
    const source=await ok('/invoices','POST',{...payload,issue_date:'2024-01-31',is_recurring:true,recurrence_interval:'MONTHLY',recurrence_end_date:'2024-04-30'});
    // Both workers may advance the schedule, but each occurrence exists once.
    await Promise.all([processRecurring({today:'2024-04-30',onError:e=>{throw e;}}),processRecurring({today:'2024-04-30',onError:e=>{throw e;}})]);
    const copies=await q('SELECT issue_date,due_date FROM documents WHERE source_recurring_id=? ORDER BY issue_date',[source.id]);
    assert.deepEqual(copies.map(r=>r.issue_date),['2024-02-29','2024-03-31','2024-04-30']);
    assert.equal((await q('SELECT is_recurring FROM documents WHERE id=?',[source.id]))[0].is_recurring,0);
    assert.equal(await generateOccurrence(uid,source.id,'2024-12-31'),null);
    const cutoff=await ok('/invoices','POST',{...payload,issue_date:'2024-01-31',is_recurring:true,recurrence_interval:'MONTHLY',recurrence_end_date:'2024-02-01'});
    assert.equal(await generateOccurrence(uid,cutoff.id,'2024-12-31'),null);
  });
  await t.test('customer reminders require opt-in, deduplicate and suppress after payment',async()=>{
    const past=await ok('/invoices','POST',{...payload,issue_date:'2024-01-01',due_date:'2024-01-01'});
    await ok(`/invoices/${past.id}/share`,'POST',{});
    await processBillingNotifications({userId:uid,today:'2024-01-15'});
    assert.equal((await q("SELECT id FROM email_outbox WHERE document_id=? AND kind='REMINDER'",[past.id])).length,0);
    await q("INSERT INTO settings(user_id,setting_key,setting_value) VALUES(?,'customer_reminders_enabled','1')",[uid]);
    await Promise.all([processBillingNotifications({userId:uid,today:'2024-01-15'}),processBillingNotifications({userId:uid,today:'2024-01-15'})]);
    const jobs=await q("SELECT id FROM email_outbox WHERE document_id=? AND kind='REMINDER'",[past.id]);assert.equal(jobs.length,1);
    await ok(`/invoices/${past.id}/mark-paid`,'POST',{amount:100,payment_date:todayIso(),payment_method:'BANK_TRANSFER'});
    let sent=false;
    assert.equal((await deliverEmail(jobs[0].id,{sendMail:async()=>{sent=true;return {accepted:['buyer@example.test']};}})).status,'CANCELLED');assert.equal(sent,false);
  });
  await t.test('SMTP acceptance reaches the queue and invoice email is not resent on retry',async()=>{
    const net=require('node:net'),nodemailer=require('nodemailer');
    const messages=[];
    const smtp=net.createServer(socket=>{
      socket.setTimeout(5000,()=>socket.destroy());
      socket.write('220 localhost ESMTP\r\n');
      let buffer='',dataMode=false,message=[];
      socket.on('data',chunk=>{
        buffer+=chunk.toString();
        while(buffer.includes('\n')) {
          const pos=buffer.indexOf('\n'),line=buffer.slice(0,pos).replace(/\r$/,'');buffer=buffer.slice(pos+1);
          if(dataMode) {
            if(line==='.') {messages.push(message.join('\n'));message=[];dataMode=false;socket.write('250 queued\r\n');}
            else message.push(line);
          } else if(/^EHLO|^HELO/.test(line)) socket.write('250-localhost\r\n250 8BITMIME\r\n');
          else if(/^DATA/.test(line)) {dataMode=true;socket.write('354 Send data\r\n');}
          else if(/^QUIT/.test(line)) socket.end('221 Bye\r\n');
          else socket.write('250 OK\r\n');
        }
      });
    });
    await new Promise(resolve=>smtp.listen(0,'127.0.0.1',resolve));
    const transport=nodemailer.createTransport({host:'127.0.0.1',port:smtp.address().port,secure:false});
    try {
      const draft=await ok('/invoices','POST',payload);
      await ok(`/invoices/${draft.id}/share`,'POST',{});
      const job=await queueEmail({userId:uid,documentId:draft.id,kind:'INVOICE',key:'smtp-acceptance',mail:{from:'sender@example.test',to:'buyer@example.test',subject:'Local SMTP test',text:'Invoice test',attachments:[{filename:'invoice.pdf',content:Buffer.from('PDF TEST')}]}});
      assert.equal((await deliverEmail(job.id,transport)).status,'ACCEPTED');
      assert.equal(messages.length,1);assert.ok(messages[0].includes('invoice.pdf'));
      const repeated=await ok(`/invoices/${draft.id}/send`,'POST',{});
      assert.equal(repeated.delivery_status,'ACCEPTED');assert.equal(messages.length,1);
    } finally {transport.close();await new Promise(resolve=>smtp.close(resolve));}
  });
  await t.test('receipt retries reuse an accepted delivery rather than duplicate the email',async()=>{
    const draft=await ok('/invoices','POST',payload);
    await ok(`/invoices/${draft.id}/mark-paid`,'POST',{amount:100,payment_date:todayIso(),payment_method:'BANK_TRANSFER'});
    const job=await queueEmail({userId:uid,documentId:draft.id,kind:'RECEIPT',key:`receipt:${draft.id}:full`,mail:{to:'buyer@example.test',subject:'Receipt',text:'Paid'}});
    await deliverEmail(job.id,{sendMail:async()=>({accepted:['buyer@example.test']})});
    assert.equal((await ok(`/invoices/${draft.id}/send-receipt`,'POST',{})).delivery_status,'ACCEPTED');
    assert.equal((await q("SELECT id FROM email_outbox WHERE document_id=? AND kind='RECEIPT'",[draft.id])).length,1);
    assert.equal((await request(`/invoices/${draft.id}/send-receipt`,'POST',{resend_key:'invalid'})).status,422);
  });
  await t.test('cancellation and payment races preserve a consistent balance',async()=>{
    const draft=await ok('/invoices','POST',payload);
    assert.equal((await request(`/invoices/${draft.id}/mark-paid`,'POST',{amount:10,payment_date:todayIso(),payment_method:'INVALID'})).status,422);
    const results=await Promise.all([request(`/invoices/${draft.id}/cancel`,'POST',{}),request(`/invoices/${draft.id}/mark-paid`,'POST',{amount:10,payment_date:todayIso(),payment_method:'BANK_TRANSFER'})]);
    assert.equal(results.filter(r=>r.status<300).length,1);
    const saved=await ok(`/invoices/${draft.id}`);
    assert.ok(saved.status==='CANCELLED' ? Number(saved.amount_paid)===0 : Number(saved.amount_paid)===10);
  });
  await t.test('password changes require the current password and revoke other sessions',async()=>{
    await q('INSERT INTO sessions(userId,token,expires) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))',[uid,hashToken(randomUUID())]);
    assert.equal((await request('/settings/profile','PUT',{contact_person:'Owner',email,new_password:password,current_password:'Incorrect2026!'})).status,400);
    await ok('/settings/profile','PUT',{contact_person:'Owner',email,new_password:password,current_password:password});
    assert.equal((await q('SELECT token FROM sessions WHERE userId=?',[uid])).length,1);
  });
  await t.test('owner email preferences and invoice mute are honoured by queued alerts',async()=>{
    await q("UPDATE settings SET setting_value='1' WHERE user_id=? AND setting_key IN ('notify_invoice_sent','notify_payment_received','notify_invoice_overdue')",[uid]);
    await q("UPDATE documents SET due_date='2024-01-01',status='OVERDUE' WHERE id=?",[invoice.id]);
    await processBillingNotifications({userId:uid});
    const jobs=await q("SELECT id,dedupe_key FROM email_outbox WHERE user_id=? AND kind='ALERT'",[uid]);
    for(const event of ['sent','payment','overdue']) assert.ok(jobs.some(job=>job.dedupe_key.startsWith(`alert:${event}:`)));
    const muted=await q("SELECT id FROM email_outbox WHERE document_id=? AND kind='ALERT'",[invoice.id]);
    assert.ok(muted.length);
    await q('UPDATE documents SET notifications_muted=1 WHERE id=?',[invoice.id]);
    const transport={sendMail:async()=>{throw new Error('Muted alert must not send');}};
    assert.equal((await deliverEmail(muted[0].id,transport)).status,'CANCELLED');
    await q("UPDATE settings SET setting_value='0' WHERE user_id=? AND setting_key LIKE 'notify_%'",[uid]);
    assert.equal((await deliverEmail(jobs.find(job=>job.id!==muted[0].id).id,transport)).status,'CANCELLED');
    const detail=await ok(`/invoices/${invoice.id}`);assert.ok(detail.email_deliveries.length);
    assert.ok(detail.email_deliveries.every(row=>!('payload' in row)));
  });
  await t.test('email changes keep the verified address until confirmation and revoke sessions',async()=>{
    const next=`new-${randomUUID()}@example.test`;
    assert.equal((await request('/settings/profile','PUT',{contact_person:'Owner',email:next})).status,400);
    const changed=await request('/settings/profile','PUT',{contact_person:'Owner',email:next,current_password:password});
    assert.ok(changed.status<300);assert.equal(changed.data.pending_email,next);
    const user=(await q('SELECT email,email_verified,pending_email FROM users WHERE id=?',[uid]))[0];
    assert.equal(user.email,email);assert.equal(user.email_verified,1);assert.equal(user.pending_email,next);
    const verification=randomUUID();await q('UPDATE users SET pending_email_token=? WHERE id=?',[hashToken(verification),uid]);
    await ok(`/verify-email?token=${verification}`);
    assert.equal((await q('SELECT email FROM users WHERE id=?',[uid]))[0].email,next);
    assert.equal((await request('/settings')).status,401);
  });  await t.test('password reset tokens are single use and revoke all sessions',async()=>{
    const reset=randomUUID(),session=randomUUID();
    await q('INSERT INTO sessions(userId,token,expires) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))',[uid,hashToken(session)]);
    await q('INSERT INTO password_reset_tokens(user_id,token,expires_at) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))',[uid,hashToken(reset)]);
    const results=await Promise.all([request('/auth/reset-password','POST',{token:reset,password}),request('/auth/reset-password','POST',{token:reset,password})]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
    assert.equal((await q('SELECT token FROM sessions WHERE userId=?',[uid])).length,0);
  });
  await t.test('account closure revokes share links and queued billing messages',async()=>{
    await q('INSERT INTO sessions(userId,token,expires) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))',[uid,hashToken(token)]);
    const draft=await ok('/invoices','POST',payload);
    const shared=await ok(`/invoices/${draft.id}/share`,'POST',{});
    const job=await queueEmail({userId:uid,documentId:draft.id,kind:'INVOICE',key:'closure-test',mail:{to:'buyer@example.test',subject:'Do not send',text:'Test'}});
    await ok('/account/close','POST',{confirm:'DELETE',password});
    assert.equal((await q('SELECT status FROM email_outbox WHERE id=?',[job.id]))[0].status,'CANCELLED');
    assert.equal((await request(`/public/invoice/${shared.token}`)).status,404);
    assert.equal((await request('/settings')).status,401);
  });

});
