const fs = require('fs');
const path = require('path');
const { encryptField, decryptField, decryptUserRow, decryptCustomerRow } = require('./encrypted-fields');

const APP_ROOT = path.resolve(__dirname, '../..');
const SELLER_FIELDS = ['company_name', 'company_registration', 'vat_number', 'address',
  'email', 'contact_person', 'phone', 'bank_name', 'bank_account_number', 'bank_branch_code', 'bank_account_type'];
const BUYER_FIELDS = ['name', 'email', 'billing_address', 'shipping_address', 'vat_number', 'phone'];
const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key] ?? null]));

function decode(row) {
  return row ? JSON.parse(decryptField('document_snapshots', 'payload', row.payload)) : null;
}

/** Call inside the issuing/payment transaction. The document lock protects the
 * draft from edits while its one-time party snapshot is captured. No payment
 * gateway credentials or live authentication fields belong in the snapshot.
 */
async function captureDocumentSnapshot(q, documentId, reason = 'issuance') {
  const [document] = await q('SELECT id, user_id, customer_id FROM documents WHERE id = ? FOR UPDATE', [documentId]);
  if (!document) throw new Error('Document not found');
  const [saved] = await q('SELECT payload FROM document_snapshots WHERE document_id = ?', [documentId]);
  if (saved) return decode(saved);
  const [sellerRow] = await q('SELECT * FROM users WHERE id = ?', [document.user_id]);
  const [buyerRow] = await q('SELECT * FROM customers WHERE id = ? AND user_id = ?', [document.customer_id, document.user_id]);
  if (!sellerRow || !buyerRow) throw new Error('Document parties not found');
  const seller = pick(decryptUserRow(sellerRow), SELLER_FIELDS);
  const buyer = pick(decryptCustomerRow(buyerRow), BUYER_FIELDS);
  const logos = await q("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [document.user_id]);
  seller.logo_data = null;
  seller.logo_type = null;
  if (logos[0]?.setting_value) {
    const logo = path.resolve(APP_ROOT, logos[0].setting_value.replace(/^[/\\]+/, ''));
    const logoRoot = path.resolve(APP_ROOT, 'uploads/logos') + path.sep;
    if (logo.startsWith(logoRoot) && fs.existsSync(logo)) {
      seller.logo_data = fs.readFileSync(logo).toString('base64');
      seller.logo_type = /\.png$/i.test(logo) ? 'image/png' : 'image/jpeg';
    }
  }
  const snapshot = { version: 1, reason, captured_at: new Date().toISOString(), seller, buyer };
  // Never overwrite a saved baseline or an issued version on retries.
  await q('INSERT INTO document_snapshots (document_id, payload) VALUES (?, ?)',
    [documentId, encryptField('document_snapshots', 'payload', JSON.stringify(snapshot))]);
  return snapshot;
}

async function readDocumentSnapshot(q, documentId) {
  const [row] = await q('SELECT payload FROM document_snapshots WHERE document_id = ?', [documentId]);
  return decode(row);
}

function applyDocumentSnapshot(row, snapshot, { includeLogo = false } = {}) {
  if (!snapshot) return row;
  const { seller, buyer } = snapshot;
  return { ...row,
    ...Object.fromEntries(['name', 'email', 'billing_address', 'vat_number'].map(key => [`customer_${key}`, buyer[key]])),
    company_name: seller.company_name, company_email: seller.email,
    company_address: seller.address, company_vat_number: seller.vat_number,
    ...pick(seller, ['bank_name', 'bank_account_number', 'bank_branch_code', 'bank_account_type']),
    ...(includeLogo ? { company_logo: seller.logo_data ? `data:${seller.logo_type};base64,${seller.logo_data}` : null } : {}),
  };
}

async function hydrateDocumentSnapshots(q, rows, options) {
  const ids = rows.filter(row => row.id && row.document_number).map(row => row.id);
  if (!ids.length) return rows;
  const snapshots = await q('SELECT document_id, payload FROM document_snapshots WHERE document_id IN (?)', [ids]);
  const byId = new Map(snapshots.map(row => [String(row.document_id), decode(row)]));
  return rows.map(row => applyDocumentSnapshot(row, byId.get(String(row.id)), options));
}

async function documentSeller(q, documentId, currentSeller) {
  const snapshot = await readDocumentSnapshot(q, documentId);
  if (!snapshot) return currentSeller;
  return { ...currentSeller, ...pick(snapshot.seller, SELLER_FIELDS),
    logo_path: snapshot.seller.logo_data ? Buffer.from(snapshot.seller.logo_data, 'base64') : null };
}

module.exports = { captureDocumentSnapshot, readDocumentSnapshot, applyDocumentSnapshot,
  hydrateDocumentSnapshots, documentSeller };
