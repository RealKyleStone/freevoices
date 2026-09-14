/**
 * PayFast: building the signed payment form, and validating the notification
 * that comes back.
 *
 * Everything in here is pure except `validateItnWithPayfast`, which is the one
 * network call. No database, no Express — so the signature logic can be
 * exercised by `npm run check:payfast` without booting a server or touching a
 * row. That matters more here than anywhere else in the codebase: a signature
 * that is wrong by one character is rejected by PayFast with a generic error
 * page, and the only way to tell a bad passphrase from a bad encoding is to
 * test the encoder in isolation.
 *
 * Two decisions worth knowing before you change anything:
 *
 * 1. We use PayFast's *custom integration*, not their "Pay Now button". The Pay
 *    Now button is a simpler GET link, but PayFast documents that it sends no
 *    ITN and it carries no m_payment_id — so money would arrive with nothing
 *    tying it to an invoice, which is the entire point of the feature.
 *
 * 2. The signature is an MD5 over the parameters in PayFast's *documented field
 *    order*, not alphabetical order. Alphabetical is their separate "API
 *    signature" used by the recurring-billing REST API. Mixing the two up is
 *    the single most common cause of a signature mismatch.
 */

const crypto = require('crypto');
const axios = require('axios');

/**
 * The shared winston logger lives in db.service, which creates the MySQL pool
 * and opens winston's file transports as import side effects — enough to keep
 * the event loop alive and hang `node --test`. Everything in this module except
 * validateItnWithPayfast is pure, so the logger is pulled in lazily on the one
 * path that actually logs, and the tests stay free of I/O.
 */
function getLogger() {
  return require('./db.service').logger;
}

/**
 * PayFast rejects anything under R5.00, and the pay page needs to say so before
 * the buyer is bounced off-site with an unexplained error.
 */
const PAYFAST_MIN_AMOUNT = 5.00;

/**
 * PayFast settles into a South African bank account and accepts ZAR only. Their
 * "multi-currency pricing" feature only changes what the buyer is *shown*; the
 * merchant is still paid in rand. So an invoice in any other currency cannot
 * use this at all.
 */
const PAYFAST_CURRENCY = 'ZAR';

/**
 * The order the signature string must be built in, taken from PayFast's own PHP
 * SDK (lib/Auth.php::generateSignature). PayFast's HTML field tables are the
 * documentation, but the SDK is the executable statement of order, so it wins.
 *
 * `passphrase` is deliberately absent: it is always appended last, by
 * buildSignatureString, and having it in this array too would append it twice.
 *
 * Subscription fields (subscription_type, billing_date, recurring_amount,
 * frequency, cycles, ...) are also absent — we only do once-off payments. If
 * subscriptions are ever added they slot in after payment_method, in the SDK's
 * order, and the passphrase becomes mandatory rather than merely strongly
 * advised.
 */
const PAYFAST_SIGNATURE_FIELD_ORDER = Object.freeze([
  'merchant_id',
  'merchant_key',
  'return_url',
  'cancel_url',
  'notify_url',
  'notify_method',
  'name_first',
  'name_last',
  'email_address',
  'cell_number',
  'm_payment_id',
  'amount',
  'item_name',
  'item_description',
  'custom_int1', 'custom_int2', 'custom_int3', 'custom_int4', 'custom_int5',
  'custom_str1', 'custom_str2', 'custom_str3', 'custom_str4', 'custom_str5',
  'email_confirmation',
  'confirmation_address',
  'currency',
  'payment_method',
]);

/**
 * The networks PayFast sends notifications from, published in their docs under
 * "Ports and IP addresses".
 *
 * This is defence in depth and nothing more — the signature check and the
 * server-side postback are what actually establish that a notification is
 * genuine. An allowlist miss behind a misconfigured proxy would otherwise take
 * the whole feature down, which is why PAYFAST_ALLOWED_IPS exists as an
 * override that needs no redeploy.
 */
const PAYFAST_DEFAULT_CIDRS = Object.freeze([
  '197.97.145.144/28',
  '41.74.179.192/27',
  '102.216.36.0/28',
  '102.216.36.128/28',
  '144.126.193.139/32',
]);

// ─── URLs ─────────────────────────────────────────────────────────────────────

/**
 * Sandbox is an exact code duplicate of production, with one universal set of
 * test credentials. Driven by a server-wide PAYFAST_MODE rather than a per-user
 * column: the sandbox only accepts *its own* merchant ID and key, so a per-user
 * "test mode" would prove the plumbing works while proving nothing at all about
 * that user's real credentials.
 */
function payfastUrls(mode) {
  const sandbox = String(mode || process.env.PAYFAST_MODE || 'live').toLowerCase() === 'sandbox';
  const host = sandbox ? 'https://sandbox.payfast.co.za' : 'https://www.payfast.co.za';
  return { sandbox, process: `${host}/eng/process`, validate: `${host}/eng/query/validate` };
}

// ─── Encoding and signing ─────────────────────────────────────────────────────

/**
 * Percent-encode one value the way PHP's urlencode() does, because that is what
 * PayFast hashes on their side.
 *
 * encodeURIComponent already emits uppercase hex (%2F, not %2f), which PayFast
 * requires. The differences that have to be patched up:
 *
 *   - space      JS gives %20, PHP urlencode gives +
 *   - ! ' ( ) *  JS leaves these bare, PHP escapes them
 *   - ~          JS leaves it bare, and so does PHP's *rawurlencode* — but
 *                PayFast uses urlencode, which escapes it to %7E. This is the
 *                one that gets missed, because every "PHP-compatible encode"
 *                snippet on the internet implements rawurlencode.
 */
function pfUrlEncode(value) {
  return encodeURIComponent(String(value).trim())
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * PayFast includes only non-blank values in the signature. Note that their PHP
 * uses empty(), which also drops the *string* "0" — so a field whose legitimate
 * value is zero would be silently omitted on their side but included on ours,
 * and the signature would never match.
 *
 * We sidestep that entire class of bug by never sending custom_int1..5 (see
 * buildPaymentFields). This helper therefore only has to agree with empty() on
 * null, undefined and whitespace.
 */
function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/**
 * Build the exact string that gets MD5'd: non-blank pairs in PAYFAST field
 * order, '&'-separated, with the passphrase appended last.
 *
 * Iterates the frozen order array rather than Object.keys(data) — key insertion
 * order would work today and break the first time someone reorders an object
 * literal, with a failure that looks like "PayFast is down".
 */
function buildSignatureString(data, passphrase) {
  const parts = [];
  for (const field of PAYFAST_SIGNATURE_FIELD_ORDER) {
    const value = data[field];
    if (isBlank(value)) continue;
    parts.push(`${field}=${pfUrlEncode(value)}`);
  }
  if (!isBlank(passphrase)) parts.push(`passphrase=${pfUrlEncode(passphrase)}`);
  return parts.join('&');
}

/** Lowercase MD5 hex of the signature string. PayFast compares case-sensitively. */
function generateSignature(data, passphrase) {
  return crypto.createHash('md5').update(buildSignatureString(data, passphrase), 'utf8').digest('hex');
}

// ─── Building the payment ─────────────────────────────────────────────────────

/**
 * item_name and item_description end up on the buyer's card statement and in
 * PayFast's dashboard, and they are part of the signed string.
 *
 * Stripped to printable ASCII on purpose. db.service.js sets no connection
 * charset while the tables are latin1, so a company name containing a smart
 * apostrophe or an accented character can already come back as a different byte
 * sequence than it went in as. If that happens between signing and posting, the
 * signature is valid for a string PayFast never sees and the payment fails with
 * no useful error. These are statement descriptors, not documents — ASCII is
 * the right trade.
 */
function sanitiseItemText(text, maxLength) {
  return String(text ?? '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** PayFast wants "1234.00" — two decimals, dot separator, no thousands separator. */
function formatAmount(value) {
  return Number(value).toFixed(2);
}

/**
 * The payment fields for one invoice, in signing order and *without* the
 * signature. Kept separate from buildPaymentForm so that the signing function
 * can never be handed a `signature` to sign — that is a structural guarantee
 * rather than a comment asking someone to be careful.
 *
 * m_payment_id is the invoice id, which is what the ITN echoes back and how we
 * find the invoice again. Deliberately not the pay token: PayFast reproduces
 * m_payment_id in buyer-facing confirmation emails and in the merchant
 * dashboard, and a token that grants payment initiation does not belong there.
 */
function buildPaymentFields({ invoice, user, customer, urls }) {
  const fields = {
    merchant_id: user.payfast_merchant_id,
    merchant_key: user.payfast_merchant_key,
    return_url: urls.returnUrl,
    cancel_url: urls.cancelUrl,
    notify_url: urls.notifyUrl,
    m_payment_id: String(invoice.id),
    amount: formatAmount(invoice.total),
    item_name: sanitiseItemText(
      `Invoice ${invoice.document_number}${user.company_name ? ` - ${user.company_name}` : ''}`,
      100
    ),
    item_description: sanitiseItemText(`Payment for invoice ${invoice.document_number}`, 255),
    custom_str1: String(invoice.user_id ?? user.id),
    custom_str2: sanitiseItemText(invoice.document_number, 255),
  };

  // Optional, and only when we actually have them — PayFast pre-fills its
  // checkout with these, which measurably reduces abandonment.
  const firstName = customer && customer.name ? sanitiseItemText(customer.name, 100) : '';
  if (firstName) fields.name_first = firstName;
  if (customer && customer.email) fields.email_address = sanitiseItemText(customer.email, 100);

  return fields;
}

/**
 * The full form: where to post, and the ordered fields to post, signature last.
 *
 * Returns an array of {name, value} rather than an object so that render order
 * is explicit and matches signing order. A mismatch between the two is
 * harmless to PayFast but makes a hand-inspected form far harder to debug.
 */
function buildPaymentForm({ invoice, user, customer, urls, mode }) {
  const fields = buildPaymentFields({ invoice, user, customer, urls });
  const signature = generateSignature(fields, user.payfast_passphrase);

  const ordered = PAYFAST_SIGNATURE_FIELD_ORDER
    .filter((name) => !isBlank(fields[name]))
    .map((name) => ({ name, value: String(fields[name]).trim() }));
  ordered.push({ name: 'signature', value: signature });

  return { action: payfastUrls(mode).process, fields: ordered };
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

/**
 * The single source of truth for "can this invoice be paid online right now".
 *
 * Used by the pay page, the invoice email, the PDF and the public portal API.
 * Duplicating any part of this is how you end up with a button printed in a PDF
 * that the pay page then refuses to honour — which the customer experiences as
 * a broken invoice.
 *
 * A missing currency_code is treated as ZAR: currency_id is nullable and older
 * rows predate the currencies join.
 */
function isPayfastEligible({ invoice, user }) {
  if (!user || !Number(user.payfast_enabled)) return false;
  if (isBlank(user.payfast_merchant_id) || isBlank(user.payfast_merchant_key)) return false;
  // No passphrase means ITN signatures cannot be verified — see verifyItnSignature.
  if (isBlank(user.payfast_passphrase)) return false;
  if (!invoice) return false;
  if (['PAID', 'CANCELLED', 'DRAFT'].includes(invoice.status)) return false;
  const currency = invoice.currency_code || PAYFAST_CURRENCY;
  if (currency !== PAYFAST_CURRENCY) return false;
  if (!(Number(invoice.total) >= PAYFAST_MIN_AMOUNT)) return false;
  return true;
}

// ─── Validating the notification ──────────────────────────────────────────────

/**
 * Rebuild the signed parameter string from the *raw* request body.
 *
 * PayFast signs the parameters in the order they were sent, up to but not
 * including `signature`. Slicing the raw body preserves their exact encoding,
 * which is the whole point: re-encoding a parsed object reintroduces every
 * pitfall pfUrlEncode exists to handle, and a single disagreement about how a
 * space or a tilde is escaped turns a genuine payment into a rejected one.
 *
 * Returns null if there is no signature pair, which the caller treats as a
 * malformed notification.
 */
function itnParamStringFromRaw(rawBody) {
  if (!rawBody) return null;
  const pairs = String(rawBody).split('&');
  const signatureIndex = pairs.findIndex((pair) => pair.split('=')[0] === 'signature');
  if (signatureIndex === -1) return null;
  return pairs.slice(0, signatureIndex).join('&');
}

/**
 * Rebuild the parameter string from already-parsed fields. The fallback for the
 * day PayFast changes something about how they serialise the body and the raw
 * slice stops matching — the caller logs which path succeeded so that shows up
 * as a log line rather than as an outage.
 */
function itnParamStringFromParsed(posted) {
  return Object.keys(posted)
    .filter((key) => key !== 'signature')
    .map((key) => `${key}=${pfUrlEncode(posted[key])}`)
    .join('&');
}

/**
 * Verify the ITN signature against one seller's passphrase.
 *
 * This check is not a formality. Every PayFast merchant can produce a
 * notification that passes the server-side postback, because for *their* own
 * transaction it is genuinely valid. Matching merchant_id and this signature
 * are the only two things standing between a stranger with a PayFast account
 * and marking someone else's invoices paid. That is why a seller without a
 * passphrase cannot enable PayFast at all.
 *
 * Returns { valid, source } so the caller can log which reconstruction worked.
 */
function verifyItnSignature(rawBody, posted, passphrase) {
  if (isBlank(passphrase)) return { valid: false, source: 'no-passphrase' };
  const supplied = String(posted.signature || '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(supplied)) return { valid: false, source: 'malformed' };

  for (const [source, paramString] of [
    ['raw', itnParamStringFromRaw(rawBody)],
    ['parsed', itnParamStringFromParsed(posted)],
  ]) {
    if (!paramString) continue;
    const expected = crypto
      .createHash('md5')
      .update(`${paramString}&passphrase=${pfUrlEncode(passphrase)}`, 'utf8')
      .digest('hex');
    // Both sides are fixed-length lowercase hex, so this is safe to compare in
    // constant time without a length check leaking anything.
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
      return { valid: true, source };
    }
  }
  return { valid: false, source: 'mismatch' };
}

/**
 * Is this address one of PayFast's?
 *
 * Node reports an IPv4 client as "::ffff:197.97.145.150" on a dual-stack
 * socket. Forgetting to strip that prefix rejects *every* notification, so it
 * is handled first and deliberately.
 */
function isPayfastIp(ip) {
  const cidrs = process.env.PAYFAST_ALLOWED_IPS
    ? process.env.PAYFAST_ALLOWED_IPS.split(',').map((c) => c.trim()).filter(Boolean)
    : PAYFAST_DEFAULT_CIDRS;

  const address = String(ip || '').replace(/^::ffff:/i, '');
  const value = ipv4ToInt(address);
  if (value === null) return false;

  return cidrs.some((cidr) => {
    const [network, bitsRaw] = cidr.split('/');
    const bits = bitsRaw === undefined ? 32 : parseInt(bitsRaw, 10);
    const networkValue = ipv4ToInt(network);
    if (networkValue === null || !(bits >= 0 && bits <= 32)) return false;
    if (bits === 0) return true;
    // >>> 0 keeps the result unsigned; JS bitwise operators work on signed
    // 32-bit ints and a /0-ish mask would otherwise come back negative.
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (networkValue & mask) >>> 0;
  });
}

function ipv4ToInt(address) {
  const octets = String(address).split('.');
  if (octets.length !== 4) return null;
  let result = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    const n = parseInt(octet, 10);
    if (n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

/**
 * Ask PayFast whether they actually sent this. The only network call in the
 * module.
 *
 * Throws on a network failure rather than returning false, because the two mean
 * different things to the caller: PayFast answering "INVALID" is a decision and
 * should stop the retries, whereas a timeout means we could not decide and
 * *want* PayFast to try again.
 */
async function validateItnWithPayfast(paramString, mode) {
  const { validate } = payfastUrls(mode);
  const response = await axios.post(validate, paramString, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
    // PayFast answers 200 with a body of VALID or INVALID. Anything else is a
    // transport problem we want surfaced as a throw.
    validateStatus: (status) => status === 200,
  });
  const body = String(response.data || '').trim();
  if (body !== 'VALID' && body !== 'INVALID') {
    getLogger().warn('PayFast validate returned an unexpected body', { body: body.slice(0, 100) });
  }
  return body === 'VALID';
}

// ─── Logging helpers ──────────────────────────────────────────────────────────

/**
 * Never let merchant_key, the passphrase or a signature reach a log file. The
 * outbound form carries the first, the signature string carries the second, and
 * combined they are enough for someone with the logs to impersonate the seller
 * to PayFast.
 */
const REDACTED_FIELDS = Object.freeze(['merchant_key', 'passphrase', 'signature', 'payfast_merchant_key', 'payfast_passphrase']);

function redactPayfast(data) {
  if (!data || typeof data !== 'object') return data;
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = REDACTED_FIELDS.includes(key) ? '[redacted]' : value;
  }
  return out;
}

module.exports = {
  PAYFAST_MIN_AMOUNT,
  PAYFAST_CURRENCY,
  PAYFAST_SIGNATURE_FIELD_ORDER,
  PAYFAST_DEFAULT_CIDRS,
  payfastUrls,
  pfUrlEncode,
  buildSignatureString,
  generateSignature,
  sanitiseItemText,
  formatAmount,
  buildPaymentFields,
  buildPaymentForm,
  isPayfastEligible,
  itnParamStringFromRaw,
  itnParamStringFromParsed,
  verifyItnSignature,
  isPayfastIp,
  validateItnWithPayfast,
  redactPayfast,
};
