/**
 * Application-layer field encryption: AES-256-GCM over individual columns.
 *
 * Introduced for the PayFast merchant credentials, which are a signing key for
 * someone else's money — a database dump containing them would let an attacker
 * forge payment notifications against every seller on the platform. That is a
 * different risk class from a bank account number, which is printed on every
 * invoice anyway.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 *
 * Built first for those PayFast credentials, then extended to the full POPIA
 * phase 6 scope: banking details, VAT and company registration numbers, phone
 * numbers and addresses on both `users` and `customers`, customer notes,
 * tracking IP addresses and payment references. See REGISTRY.
 *
 * Extending it further is additive: add the entry, widen the column in a
 * migration, wire the call sites, run scripts/encrypt-backfill.js. Nothing in
 * this file should need rewriting for that.
 *
 * This module also owns hashToken(), which is a different mechanism for a
 * different job — see the comment above it.
 *
 * ── The rules, and why ──────────────────────────────────────────────────────
 *
 * Keys come from DATA_ENCRYPTION_KEYS as `<id>:<base64>,<id>:<base64>`, with
 * DATA_ENCRYPTION_KEY_ACTIVE naming the one to write with. Multiple keys exist
 * so a rotation can read old rows while writing new ones.
 *
 * A key must base64-decode to exactly 32 bytes. There is deliberately NO
 * passphrase fallback: hashing a human-chosen passphrase hands the derivation
 * about 40 bits of entropy and returns 32 bytes that *look* uniformly random,
 * which is the most dangerous possible failure mode — it works, and it is weak.
 *
 * AAD is `fv1|<table>|<column>`. Binding the table and column means a
 * users.payfast_passphrase blob pasted into another column fails to decrypt
 * instead of silently succeeding. Row id is deliberately NOT bound: ids do not
 * exist at INSERT time, and binding them would make a single-row backup restore
 * permanently unreadable.
 *
 * ── The trap to know about before extending the registry ────────────────────
 *
 * Every row gets a random IV, so the same plaintext encrypts to a different
 * value every time. That means an encrypted column can never be used in a
 * WHERE ... LIKE, an ORDER BY, a GROUP BY, or a UNIQUE index — all of those
 * return wrong results *silently* rather than erroring. If exact-match lookup
 * is ever needed, add a separate HMAC blind-index column. Never weaken this to
 * deterministic mode to make a query work.
 *
 * (This is exactly why the PayFast ITN de-duplicates on a plaintext
 * payments.provider_payment_id rather than on the encrypted
 * payments.transaction_reference.)
 */

const crypto = require('crypto');

/**
 * Envelope prefix and version. `fv1.<keyId>$<base64url(iv|ciphertext|tag)>`.
 *
 * Kept to printable ASCII so it is byte-identical in latin1 and utf8mb4, which
 * makes the column's character set irrelevant and lets these live in ordinary
 * varchar columns rather than VARBINARY. (VARBINARY would make mysql2 hand back
 * a Buffer, so a missed decrypt would surface as `{"type":"Buffer",...}`
 * instead of a recognisable `fv1.1$...`.)
 */
const ENVELOPE_PREFIX = 'fv1.';
const IV_BYTES = 12;    // GCM standard nonce length
const TAG_BYTES = 16;
const KEY_BYTES = 32;   // AES-256

/**
 * Constant across all fields — domain separation between this use of the master
 * key and any future one. Per-field separation is the AAD's job, not HKDF's.
 */
const HKDF_INFO = 'aes-256-gcm/field/v1';

/**
 * Columns that are stored encrypted, by table.
 *
 * Adding an entry here is not sufficient on its own: the column must be wide
 * enough for the envelope (varchar(512) comfortably holds anything short), and
 * existing rows need the backfill. See the header before extending this.
 */
const REGISTRY = Object.freeze({
  users: Object.freeze([
    'payfast_merchant_id', 'payfast_merchant_key', 'payfast_passphrase',
    'bank_account_number', 'bank_branch_code', 'bank_account_type',
    'vat_number', 'company_registration', 'phone', 'address',
  ]),
  customers: Object.freeze(['phone', 'vat_number', 'billing_address', 'shipping_address', 'notes']),
  document_tracking: Object.freeze(['ip_address', 'user_agent']),
  payments: Object.freeze(['transaction_reference']),
});

/**
 * Deliberately NOT encrypted, and this list is as load-bearing as the one
 * above: `users.email`, `customers.name` and `customers.email`.
 *
 * Random IVs make ciphertext unique per row, so encrypting these would silently
 * break customer search (`name LIKE ?`), `ORDER BY name`, pagination and the
 * four report endpoints — returning wrong results rather than erroring. They
 * are identifying data we accept the exposure on, in exchange for the app
 * continuing to work. Revisit only with a blind-index column, never by making
 * the field encryption deterministic.
 */

/** The known plaintext the canary row round-trips. Not a secret. */
const CANARY_PLAINTEXT = 'freevoices-canary-v1';

// ─── Keyring ──────────────────────────────────────────────────────────────────

let keyringCache = null;

/**
 * Parse and validate DATA_ENCRYPTION_KEYS once.
 *
 * Returns null when no keyring is configured at all, which callers treat as
 * "encryption unavailable" rather than as an error — an operator who has not
 * generated a key still gets a working app, just without PayFast. A keyring
 * that is present but malformed is always an error: that means someone tried to
 * configure this and got it wrong, and continuing would write unreadable rows.
 */
function loadKeyring() {
  if (keyringCache !== null) return keyringCache.keys ? keyringCache : null;

  const raw = process.env.DATA_ENCRYPTION_KEYS;
  if (!raw || !raw.trim()) {
    keyringCache = { keys: null };
    return null;
  }

  const keys = new Map();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    if (separator === -1) {
      throw new Error(
        `DATA_ENCRYPTION_KEYS: the entry starting "${trimmed.slice(0, 8)}..." has no key id. ` +
        'Every entry must be <id>:<base64> — put an id and a colon in front of the key, e.g. ' +
        `DATA_ENCRYPTION_KEYS=1:${trimmed.slice(0, 8)}...  and set DATA_ENCRYPTION_KEY_ACTIVE=1. ` +
        'The key itself is fine; only the prefix is missing, so there is no need to generate a new one.'
      );
    }
    const id = trimmed.slice(0, separator).trim();
    const material = trimmed.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(`DATA_ENCRYPTION_KEYS: key id "${id}" must be alphanumeric`);
    }
    if (keys.has(id)) {
      throw new Error(`DATA_ENCRYPTION_KEYS: key id "${id}" appears more than once`);
    }
    const decoded = Buffer.from(material, 'base64');
    // Buffer.from is famously lenient — it ignores invalid characters rather
    // than throwing — so the length check is what actually validates the key.
    if (decoded.length !== KEY_BYTES) {
      throw new Error(
        `DATA_ENCRYPTION_KEYS: key "${id}" decodes to ${decoded.length} bytes, expected ${KEY_BYTES}. ` +
        'Generate a ready-to-paste entry with: ' +
        'node -e "console.log(\'1:\' + require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
      );
    }
    keys.set(id, decoded);
  }

  if (keys.size === 0) throw new Error('DATA_ENCRYPTION_KEYS is set but contains no usable keys');

  const activeId = (process.env.DATA_ENCRYPTION_KEY_ACTIVE || '').trim() || [...keys.keys()][0];
  if (!keys.has(activeId)) {
    throw new Error(
      `DATA_ENCRYPTION_KEY_ACTIVE="${activeId}" names a key that is not in DATA_ENCRYPTION_KEYS ` +
      `(available: ${[...keys.keys()].join(', ')})`
    );
  }

  keyringCache = { keys, activeId };
  return keyringCache;
}

/** Clear the cache. Tests only — the keyring never changes at runtime. */
function resetKeyringCache() {
  keyringCache = null;
}

function isEncryptionConfigured() {
  return loadKeyring() !== null;
}

function requireKeyring() {
  const keyring = loadKeyring();
  if (!keyring) {
    const err = new Error('Field encryption is not configured (set DATA_ENCRYPTION_KEYS)');
    err.code = 'ENCRYPTION_UNAVAILABLE';
    throw err;
  }
  return keyring;
}

/**
 * Derive the actual data key from a master key.
 *
 * hkdfSync returns an ArrayBuffer, not a Buffer — wrapping it is required, and
 * forgetting to produces a cipher that throws about an invalid key length.
 */
function deriveKey(master) {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), HKDF_INFO, KEY_BYTES));
}

function additionalData(table, column) {
  return Buffer.from(`fv1|${table}|${column}`, 'utf8');
}

// ─── Encrypt / decrypt ────────────────────────────────────────────────────────

/** Does this value look like something we produced? */
function isEnvelope(value) {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Encrypt one value. null/undefined/'' pass through unchanged so that "no value
 * stored" stays distinguishable from "an encrypted empty string", and so a
 * cleared field is a plain NULL the database can index and count.
 */
function encryptField(table, column, plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;

  const { keys, activeId } = requireKeyring();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(keys.get(activeId)), iv);
  cipher.setAAD(additionalData(table, column));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);

  return `${ENVELOPE_PREFIX}${activeId}$${payload.toString('base64url')}`;
}

/**
 * Decrypt one value.
 *
 * Anything that is not an envelope is returned as-is. That transitional
 * behaviour is free here (these columns start empty) and mandatory later: the
 * POPIA backfill runs while the application is live, so deployed code has to
 * read plaintext and ciphertext identically for the duration.
 */
function decryptField(table, column, value) {
  if (!isEnvelope(value)) return value;

  const separator = value.indexOf('$');
  if (separator === -1) throw new Error(`Malformed envelope in ${table}.${column}`);
  const keyId = value.slice(ENVELOPE_PREFIX.length, separator);

  const { keys } = requireKeyring();
  const master = keys.get(keyId);
  if (!master) {
    throw new Error(
      `${table}.${column} was encrypted with key "${keyId}", which is not in DATA_ENCRYPTION_KEYS. ` +
      'Add the old key to the keyring — it is needed to read existing rows.'
    );
  }

  const payload = Buffer.from(value.slice(separator + 1), 'base64url');
  if (payload.length < IV_BYTES + TAG_BYTES) throw new Error(`Truncated envelope in ${table}.${column}`);

  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);

  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(master), iv);
  decipher.setAAD(additionalData(table, column));
  decipher.setAuthTag(tag);
  // final() throws if the tag does not verify — wrong key, tampered ciphertext,
  // or a value moved between columns. All three should be loud.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ─── Token hashing ────────────────────────────────────────────────────────────

/**
 * One-way SHA-256 for bearer tokens: session tokens, password-reset tokens,
 * email-verification tokens and invoice share tokens.
 *
 * Hashing, NOT encryption, and the difference is the point. These values are
 * never read back — they only ever arrive from a client and get compared — so
 * there is nothing to decrypt and no reason to keep them recoverable. A stolen
 * database then yields no usable session, no working reset link and no readable
 * invoice.
 *
 * Deliberately UNPEPPERED: no keyring input. Peppering from the data key would
 * tie every live session and every share link already sitting in a customer's
 * inbox to that key's lifecycle, so rotating it would log everyone out and 404
 * links we have already sent. These are 122-bit random UUIDs; against an
 * attacker who cannot brute-force them, a pepper buys nothing for that cost.
 *
 * Note what is NOT hashed: `documents.pay_token`. That one has to stay
 * recoverable, because every invoice email and PDF must be able to quote the
 * same payment URL months after it was minted — see ensurePayToken in
 * server.js. A hash cannot be turned back into a URL.
 */
function hashToken(token) {
  if (token === null || token === undefined || token === '') return token;
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** Columns holding hashed tokens, for the backfill. */
const HASHED_TOKEN_COLUMNS = Object.freeze([
  ['sessions', 'token'],
  ['password_reset_tokens', 'token'],
  ['users', 'email_verification_token'],
  ['documents', 'share_token'],
]);

// ─── Row mappers ──────────────────────────────────────────────────────────────

/**
 * Decrypt every registered column present on a row.
 *
 * Returns a new object; columns the query did not select are left alone, which
 * is what makes this safe to apply to the narrow SELECTs as well as `SELECT *`.
 */
function decryptRow(table, row) {
  if (!row) return row;
  const columns = REGISTRY[table];
  if (!columns) return row;

  const out = { ...row };
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(out, column)) {
      out[column] = decryptField(table, column, out[column]);
    }
  }
  return out;
}

/** Encrypt every registered column present on an input object. */
function encryptRow(table, input) {
  if (!input) return input;
  const columns = REGISTRY[table];
  if (!columns) return input;

  const out = { ...input };
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(out, column)) {
      out[column] = encryptField(table, column, out[column]);
    }
  }
  return out;
}

/**
 * Decrypt columns that a JOIN has aliased, e.g. `c.billing_address AS
 * customer_billing_address`.
 *
 * The AAD is built from the REAL table and column, never the alias — the alias
 * is only how this query happened to name it, while the AAD is part of what was
 * sealed at write time.
 */
function decryptAliasedRow(table, row, prefix) {
  if (!row) return row;
  const columns = REGISTRY[table];
  if (!columns) return row;

  const out = { ...row };
  for (const column of columns) {
    const alias = `${prefix}${column}`;
    if (Object.prototype.hasOwnProperty.call(out, alias)) {
      out[alias] = decryptField(table, column, out[alias]);
    }
  }
  return out;
}

const decryptUserRow = (row) => decryptRow('users', row);
const encryptUserInput = (input) => encryptRow('users', input);
const decryptCustomerRow = (row) => decryptRow('customers', row);
const encryptCustomerInput = (input) => encryptRow('customers', input);
const decryptPaymentRow = (row) => decryptRow('payments', row);
const decryptTrackingRow = (row) => decryptRow('document_tracking', row);

/** `c.<col> AS customer_<col>`, the aliasing every invoice/quote join uses. */
const decryptCustomerJoin = (row) => decryptAliasedRow('customers', row, 'customer_');

/**
 * The shape most invoice and quote queries return: document columns, the
 * seller's own `users` columns unaliased, and the customer's columns under a
 * `customer_` prefix.
 *
 * Composing mappers is safe because each only touches the column names it owns
 * and decryptField passes non-envelopes straight through. What is NOT safe is
 * applying the wrong one: `phone`, `vat_number` and `notes` all exist on more
 * than one table, so a customers value run through the users mapper fails the
 * auth tag — loudly, which is the point of binding the table into the AAD.
 */
const decryptInvoiceJoin = (row) => decryptCustomerJoin(decryptUserRow(row));

// ─── Canary ───────────────────────────────────────────────────────────────────

/**
 * Refuse to run against the wrong key.
 *
 * The failure this prevents: deploying to a fresh machine with a freshly
 * generated key. Every check passes — the key is present, well-formed, the
 * right length — the app boots cleanly, and then serves errors on every read
 * while writing new rows under a key that cannot read the old ones. Two key
 * generations get mixed into one table and there is no clean way back.
 *
 * The canary is a known plaintext encrypted once, on first run. If it stops
 * decrypting, the key changed, and the only safe response is to stop.
 *
 * db.service is required lazily: it creates the MySQL pool and opens winston's
 * file transports on import, which would make this module impossible to unit
 * test without I/O.
 */
/**
 * How many rows hold an encrypted value right now.
 *
 * Used only to make a canary failure actionable. "Restore the correct key" is
 * the right advice when real data depends on it and catastrophic advice to
 * follow blindly when none does — a fresh or rebuilt environment whose canary
 * predates the current key just needs the stale row cleared. Counting is the
 * difference between those two cases, and the code can check it far more
 * reliably than a person reading a stack trace at the wrong end of a deploy.
 *
 * Table and column names come from the frozen REGISTRY above, never from input.
 */
async function countEncryptedValues(executeQuery) {
  let total = 0;
  for (const [table, columns] of Object.entries(REGISTRY)) {
    const anyPresent = columns.map((c) => `${c} IS NOT NULL`).join(' OR ');
    const rows = await executeQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE ${anyPresent}`);
    total += Number(rows[0].n);
  }
  return total;
}

async function verifyCanary() {
  const { executeQuery } = require('./db.service');
  const rows = await executeQuery('SELECT key_id, envelope FROM crypto_canary WHERE id = 1');

  if (!isEncryptionConfigured()) {
    // A canary row means encrypted data has been written at some point. Booting
    // without a keyring would then leave those columns permanently unreadable
    // while the app cheerfully carries on, so this is fatal rather than skipped.
    if (rows.length > 0) {
      throw new Error(
        'Encryption key check FAILED: crypto_canary holds a row written with key ' +
        `"${rows[0].key_id}", but DATA_ENCRYPTION_KEYS is not set. Restore the keyring — ` +
        'encrypted columns cannot be read without it.'
      );
    }
    // POPIA phase 6 put core personal data behind this key — bank details, VAT
    // and registration numbers, phones, addresses, customer notes. Booting
    // without it would mean every write silently storing plaintext into a
    // column the privacy policy says is encrypted, which is worse than not
    // starting. Before phase 6 only PayFast used encryption and this returned
    // "skipped"; that is no longer a defensible default.
    throw new Error(
      'DATA_ENCRYPTION_KEYS is not set. Personal information is stored encrypted, so the ' +
      'application will not start without its key. Generate one with: ' +
      `node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"`
    );
  }

  const { activeId } = requireKeyring();

  if (rows.length === 0) {
    await executeQuery(
      'INSERT INTO crypto_canary (id, key_id, envelope) VALUES (1, ?, ?)',
      [activeId, encryptField('crypto_canary', 'envelope', CANARY_PLAINTEXT)]
    );
    return { status: 'created', keyId: activeId };
  }

  let decrypted;
  try {
    decrypted = decryptField('crypto_canary', 'envelope', rows[0].envelope);
  } catch (err) {
    // Work out whether anything actually depends on the key we cannot read,
    // because that decides the fix. Never let this diagnostic throw over the
    // real error.
    let stored = null;
    try {
      stored = await countEncryptedValues(executeQuery);
    } catch { /* the count is a nicety; the key failure is the news */ }

    const advice = stored === 0
      ? 'Nothing is encrypted yet — 0 rows across the registry hold a value — so this canary is the ' +
        'only thing the old key protects. If this environment was rebuilt, or the row was written by ' +
        'a different deployment sharing this database, it is safe to clear it with ' +
        '"DELETE FROM crypto_canary" and let the next boot write a fresh one under the current key.'
      : `${stored} row(s) hold encrypted values that ONLY the original key can read. Restore that key. ` +
        'Clearing the canary would let the app start and then fail on every one of those rows.';

    throw new Error(
      `Encryption key check FAILED: the stored canary (written with key "${rows[0].key_id}") ` +
      `cannot be decrypted with the current DATA_ENCRYPTION_KEYS. ${err.message}. ${advice}`
    );
  }
  if (decrypted !== CANARY_PLAINTEXT) {
    throw new Error('Encryption key check FAILED: the canary decrypted to an unexpected value.');
  }

  return { status: 'verified', keyId: rows[0].key_id };
}

module.exports = {
  ENVELOPE_PREFIX,
  REGISTRY,
  CANARY_PLAINTEXT,
  isEncryptionConfigured,
  isEnvelope,
  encryptField,
  decryptField,
  encryptRow,
  decryptRow,
  hashToken,
  HASHED_TOKEN_COLUMNS,
  decryptUserRow,
  encryptUserInput,
  decryptCustomerRow,
  encryptCustomerInput,
  decryptPaymentRow,
  decryptTrackingRow,
  decryptCustomerJoin,
  decryptInvoiceJoin,
  decryptAliasedRow,
  verifyCanary,
  resetKeyringCache,
};
