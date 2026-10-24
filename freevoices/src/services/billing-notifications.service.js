const {executeQuery}=require('./db.service');
const {decryptCustomerRow}=require('./encrypted-fields');
const {readDocumentSnapshot}=require('./document-snapshot.service');
const {queueEmail}=require('./outbox.service');
const {shareDocument}=require('./document-share.service');
const {todayIso}=require('./document-math');

async function processBillingNotifications({today=todayIso(),userId=null}={}) {
  const users=await executeQuery("SELECT id,email FROM users WHERE status='ACTIVE'"+(userId?' AND id=?':''),userId?[userId]:[]);
  const from={name:process.env.SMTP_FROM_NAME || 'Freevoices',address:process.env.SMTP_FROM_ADDRESS || process.env.SMTP_FROM || process.env.SMTP_USER};
  for(const user of users) {
    const settings=Object.fromEntries((await executeQuery('SELECT setting_key,setting_value FROM settings WHERE user_id=?',[user.id])).map(s=>[s.setting_key,s.setting_value]));
    const own=async(kind,key,subject,text,documentId)=>queueEmail({userId:user.id,documentId,kind,key,mail:{from,to:user.email,subject,text}});
    if(settings.notify_invoice_sent!=='0') {
      const sent=await executeQuery(`SELECT e.id,d.id AS document_id,d.document_number FROM email_outbox e JOIN documents d ON d.id=e.document_id
        WHERE e.user_id=? AND e.kind='INVOICE' AND e.status='ACCEPTED' AND e.accepted_at>=DATE_SUB(NOW(),INTERVAL 1 DAY) AND d.notifications_muted=0`,[user.id]);
      for(const row of sent) await own('ALERT',`alert:sent:${row.id}`,`Invoice ${row.document_number}: email accepted`,'Your email provider accepted this invoice email. This does not confirm delivery to the inbox.',row.document_id);
    }
    if(settings.notify_payment_received!=='0') {
      const paid=await executeQuery(`SELECT p.id,p.amount,d.id AS document_id,d.document_number,c.code FROM payments p JOIN documents d ON d.id=p.document_id
        JOIN currencies c ON c.id=d.currency_id WHERE d.user_id=? AND p.created_at>=DATE_SUB(NOW(),INTERVAL 1 DAY) AND d.notifications_muted=0`,[user.id]);
      for(const row of paid) await own('ALERT',`alert:payment:${row.id}`,`Payment recorded: ${row.document_number}`,`${row.code} ${row.amount} has been recorded against this invoice.`,row.document_id);
    }
    const overdue=await executeQuery(`SELECT d.*,c.code AS currency_code FROM documents d JOIN currencies c ON c.id=d.currency_id
      WHERE d.user_id=? AND d.type='INVOICE' AND d.status IN ('SENT','OVERDUE') AND d.due_date<? AND d.notifications_muted=0
      AND d.total>(SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.document_id=d.id)`,[user.id,today]);
    for(const doc of overdue) {
      if(settings.notify_invoice_overdue!=='0') await own('ALERT',`alert:overdue:${doc.id}`,`Invoice overdue: ${doc.document_number}`,`Invoice ${doc.document_number} was due on ${doc.due_date}. Review it in Freevoices.`,doc.id);
      if(settings.customer_reminders_enabled!=='1') continue;
      const days=Math.floor((Date.parse(today)-Date.parse(doc.due_date))/86400000);
      const stage=days>=14?14:days>=7?7:1;
      // On recovery, send only the latest due reminder, not every missed stage.
      const key=`reminder:${doc.id}:${stage}`;
      if((await executeQuery('SELECT id FROM email_outbox WHERE user_id=? AND dedupe_key=?',[user.id,key])).length) continue;
      const snapshot=await readDocumentSnapshot(executeQuery,doc.id);
      const buyer=snapshot?.buyer || decryptCustomerRow((await executeQuery('SELECT * FROM customers WHERE id=? AND user_id=?',[doc.customer_id,user.id]))[0]);
      if(!buyer?.email) continue;
      const shared=await shareDocument(user.id,doc.id);
      const link=`${String(process.env.APP_URL || '').replace(/\/$/,'')}/portal/invoice/${shared.token}`;
      await queueEmail({userId:user.id,documentId:doc.id,kind:'REMINDER',key,mail:{from,to:buyer.email,
        subject:`Payment reminder: ${doc.document_number}`,
        text:`Invoice ${doc.document_number} was due on ${doc.due_date}. View your invoice and current balance: ${link}\nIf you have already paid, please contact the business so they can update their records.`}});
    }
  }
}
module.exports={processBillingNotifications};
