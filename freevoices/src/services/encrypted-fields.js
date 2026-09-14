/**
 * Application-layer field encryption: AES-256-GCM over individual columns.
 *
 * Introduced for the PayFast merchant credentials, which are a signing key for
 * someone else's money — a database dump containing them would let an attacker
 * forge payment notifications against every seller on the platform. That is a
 * different risk class from a bank account number, which is printed on every
 * invoice anyway.
 *
 * ── This is deliberately the POPIA plan's design, built early and small ──────
 *
 * The full compliance programme encrypts roughly a dozen columns across five
 * tables. Everything structural for that is here already — the keyring, the
 * envelope format, the derivation, the AAD binding, the canary — and the
 * REGISTRY below is seeded with only the three PayFast columns. Extending it
 * later is an additive change: add table/column entries, widen the columns in a
 * migration, run the backfill. Nothing here should need to be rewritten.
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
  users: Object.freeze(['payfast_merchant_id', 'payfast_merchant_key', 'payfast_passphrase']),
});

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

const decryptUserRow = (row) => decryptRow('users', row);
const encryptUserInput = (input) => encryptRow('users', input);

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
    return { status: 'skipped', reason: 'no keyring configured' };
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
  decryptUserRow,
  encryptUserInput,
  verifyCanary,
  resetKeyringCache,
};
