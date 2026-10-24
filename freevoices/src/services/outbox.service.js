const { executeQuery, withTransaction } = require('./db.service');
const { encryptField, decryptField } = require('./encrypted-fields');

async function queueEmail({userId,documentId=null,kind,key,mail}) {
  const payload = {...mail,attachments:(mail.attachments || []).map(a => ({...a,
    content:Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
    encoding:Buffer.isBuffer(a.content) ? 'base64' : a.encoding}))};
  return withTransaction(async q => {
    await q('SELECT id FROM users WHERE id=? FOR UPDATE',[userId]);
    const [existing] = await q('SELECT id,status FROM email_outbox WHERE user_id=? AND dedupe_key=? FOR UPDATE',[userId,key]);
    if (existing) return existing;
    const result = await q(`INSERT INTO email_outbox(user_id,document_id,kind,dedupe_key,payload) VALUES(?,?,?,?,?)`,
      [userId,documentId,kind,key,encryptField('email_outbox','payload',JSON.stringify(payload))]);
    if (kind==='INVOICE') await q("UPDATE documents SET delivery_status='QUEUED',delivery_error=NULL WHERE id=? AND user_id=?",[documentId,userId]);
    return {id:result.insertId,status:'QUEUED'};
  });
}

async function deliverEmail(id,transporter,{retry=false}={}) {
  const [candidate]=await executeQuery('SELECT user_id FROM email_outbox WHERE id=?',[id]);
  if(!candidate) return {status:'MISSING'};
  const claimed = await withTransaction(async q => {
    const [owner]=await q('SELECT status FROM users WHERE id=? FOR UPDATE',[candidate.user_id]);
    const [row] = await q('SELECT * FROM email_outbox WHERE id=? FOR UPDATE',[id]);
    if (!row) return null;
    let suppress=owner?.status!=='ACTIVE';
    if(row.kind==='ALERT' && row.dedupe_key.startsWith('alert:')) {
      const preference={sent:'notify_invoice_sent',payment:'notify_payment_received',overdue:'notify_invoice_overdue'}[row.dedupe_key.split(':')[1]];
      const [setting]=await q('SELECT setting_value FROM settings WHERE user_id=? AND setting_key=?',[row.user_id,preference]);
      const [doc]=await q('SELECT notifications_muted FROM documents WHERE id=?',[row.document_id]);
      suppress ||= setting?.setting_value==='0' || !!doc?.notifications_muted;
    }
    if(['INVOICE','REMINDER'].includes(row.kind)) {
      const [doc]=await q(`SELECT d.status,d.notifications_muted,d.total,
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE document_id=d.id) AS paid
        FROM documents d WHERE d.id=? FOR UPDATE`,[row.document_id]);
      const [enabled]=await q("SELECT setting_value FROM settings WHERE user_id=? AND setting_key='customer_reminders_enabled'",[row.user_id]);
      suppress ||= !doc || ['PAID','CANCELLED'].includes(doc.status);
      if(row.kind==='REMINDER') suppress ||= doc?.notifications_muted || !['SENT','OVERDUE'].includes(doc?.status) || Number(doc?.paid)>=Number(doc?.total) || enabled?.setting_value!=='1';
    }
    if(suppress && ['QUEUED','FAILED'].includes(row.status)) {
      await q("UPDATE email_outbox SET status='CANCELLED',last_error='Message suppressed by account, payment or notification preferences' WHERE id=?",[id]);
      if(row.kind==='INVOICE') await q("UPDATE documents SET delivery_status='NOT_SENT',delivery_error='Queued email suppressed because this invoice or account is no longer active.' WHERE id=?",[row.document_id]);
      return {skip:'CANCELLED'};
    }
    if (!['QUEUED','FAILED'].includes(row.status) || (!retry && (row.attempts>=5 || new Date(row.next_attempt_at)>new Date()))) return {skip:row.status,error:row.last_error};
    await q("UPDATE email_outbox SET status='SENDING',attempts=attempts+1,lease_until=DATE_ADD(NOW(),INTERVAL 5 MINUTE) WHERE id=?",[id]);
    if (row.kind==='INVOICE') await q("UPDATE documents SET delivery_status='SENDING',delivery_error=NULL WHERE id=?",[row.document_id]);
    return row;
  });
  if (!claimed) return {status:'MISSING'};
  if (claimed.skip) return {status:claimed.skip,error:claimed.error};
  let status='ACCEPTED', error=null;
  try {
    const mail=JSON.parse(decryptField('email_outbox','payload',claimed.payload));
    const info=await transporter.sendMail(mail);
    if (!info.accepted?.length || info.rejected?.length) throw Object.assign(new Error('Recipient rejected'),{code:'ERECIPIENT'});
  } catch(e) {
    // A dropped connection after DATA may mean the server accepted the mail.
    // Do not automatically resend an ambiguous attempt.
    status=e.command==='DATA' && !e.responseCode ? 'UNCERTAIN' : 'FAILED';
    error=status==='UNCERTAIN' ? 'Acceptance could not be confirmed; check with your email provider before resending.' : (claimed.attempts>=4 ? 'Automatic retries exhausted. Retry manually after checking email settings.' : 'Email provider did not accept the message. A retry is scheduled.');
  }
  await withTransaction(async q => {
    await q(`UPDATE email_outbox SET status=?,last_error=?,lease_until=NULL,
      accepted_at=IF(?='ACCEPTED',NOW(),accepted_at),next_attempt_at=DATE_ADD(NOW(),INTERVAL 15 MINUTE) WHERE id=?`,[status,error,status,id]);
    if (claimed.kind==='INVOICE') await q('UPDATE documents SET delivery_status=?,delivery_error=? WHERE id=?',[status,error,claimed.document_id]);
  });
  return {status,error};
}

async function processOutbox(transporter) {
  // Recovery never assumes a worker dying after SMTP acceptance means failure.
  await withTransaction(async q => {
    const rows=await q("SELECT id,document_id,kind FROM email_outbox WHERE status='SENDING' AND lease_until<NOW() FOR UPDATE");
    for (const row of rows) {
      await q("UPDATE email_outbox SET status='UNCERTAIN',lease_until=NULL,last_error='Worker stopped before acceptance was recorded; check provider before resending.' WHERE id=?",[row.id]);
      if(row.kind==='INVOICE') await q("UPDATE documents SET delivery_status='UNCERTAIN',delivery_error='Check email provider before resending.' WHERE id=?",[row.document_id]);
    }
  });
  const rows=await executeQuery("SELECT id FROM email_outbox WHERE status IN ('QUEUED','FAILED') AND attempts<5 AND next_attempt_at<=NOW() ORDER BY id LIMIT 50");
  for(const row of rows) await deliverEmail(row.id,transporter);
}

async function captureEmail(service,method,...args) {
  let mail;
  const capture=Object.create(service);
  capture.transporter={options:service.transporter.options,sendMail:async options=>{mail=options;return {accepted:[options.to]};}};
  await capture[method](...args);
  if (!mail) throw new Error('Email renderer did not produce a message');
  return mail;
}
module.exports={queueEmail,deliverEmail,processOutbox,captureEmail};
