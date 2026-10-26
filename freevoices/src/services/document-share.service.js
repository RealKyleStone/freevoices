const { randomUUID } = require('crypto');
const { withTransaction } = require('./db.service');
const { encryptField, decryptField, hashToken } = require('./encrypted-fields');

async function shareDocument(userId, id, { rotate = false, revoke = false, type = 'INVOICE' } = {}) {
  return withTransaction(async q => {
    const [document] = await q('SELECT share_token,share_token_expires_at FROM documents WHERE id=? AND user_id=? AND type=? FOR UPDATE', [id,userId,type]);
    if (!document) throw Object.assign(new Error(`${type === 'QUOTE' ? 'Quote' : 'Invoice'} not found`),{ status:404 });
    if (revoke) {
      await q('UPDATE documents SET share_token=NULL,share_token_expires_at=NULL WHERE id=?', [id]);
      await q('DELETE FROM document_share_links WHERE document_id=?', [id]);
      return { message:'Share link revoked' };
    }
    const [saved] = await q('SELECT payload FROM document_share_links WHERE document_id=?', [id]);
    if (!rotate && saved && document.share_token_expires_at && new Date(document.share_token_expires_at)>new Date()) {
      const token = decryptField('document_share_links','payload',saved.payload);
      if (hashToken(token)===document.share_token) return { token, expires_at:document.share_token_expires_at };
    }
    const token = randomUUID().replace(/-/g,'');
    await q('UPDATE documents SET share_token=?,share_token_expires_at=DATE_ADD(NOW(),INTERVAL 30 DAY) WHERE id=?',[hashToken(token),id]);
    await q('INSERT INTO document_share_links(document_id,payload) VALUES(?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload)',[id,encryptField('document_share_links','payload',token)]);
    const [updated] = await q('SELECT share_token_expires_at FROM documents WHERE id=?',[id]);
    return { token, expires_at:updated.share_token_expires_at };
  });
}
module.exports = { shareDocument };
