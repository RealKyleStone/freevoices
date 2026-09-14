/**
 * Tests for application-layer field encryption.
 *
 * Run with:  node --test
 *
 * verifyCanary() is not covered here — it is the only function that touches the
 * database, and standing up MySQL for it would defeat the point of keeping this
 * suite I/O-free. It is exercised by booting the server (phase C).
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const ef = require('../src/services/encrypted-fields');

const KEY_1 = crypto.randomBytes(32).toString('base64');
const KEY_2 = crypto.randomBytes(32).toString('base64');

/** Install a keyring for one test and restore whatever was there afterwards. */
function withKeyring(t, keys, activeId) {
  const originalKeys = process.env.DATA_ENCRYPTION_KEYS;
  const originalActive = process.env.DATA_ENCRYPTION_KEY_ACTIVE;

  if (keys === null) delete process.env.DATA_ENCRYPTION_KEYS;
  else process.env.DATA_ENCRYPTION_KEYS = keys;

  if (activeId === undefined) delete process.env.DATA_ENCRYPTION_KEY_ACTIVE;
  else process.env.DATA_ENCRYPTION_KEY_ACTIVE = activeId;

  ef.resetKeyringCache();

  t.after(() => {
    if (originalKeys === undefined) delete process.env.DATA_ENCRYPTION_KEYS;
    else process.env.DATA_ENCRYPTION_KEYS = originalKeys;
    if (originalActive === undefined) delete process.env.DATA_ENCRYPTION_KEY_ACTIVE;
    else process.env.DATA_ENCRYPTION_KEY_ACTIVE = originalActive;
    ef.resetKeyringCache();
  });
}

// ─── Round trip ───────────────────────────────────────────────────────────────

test('encrypt/decrypt round-trips', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  const secret = 'jt7NOE43FZPn';
  const envelope = ef.encryptField('users', 'payfast_passphrase', secret);

  assert.notStrictEqual(envelope, secret);
  assert.match(envelope, /^fv1\.1\$[A-Za-z0-9_-]+$/);
  assert.strictEqual(ef.decryptField('users', 'payfast_passphrase', envelope), secret);
});

test('the same plaintext encrypts differently every time', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  const a = ef.encryptField('users', 'payfast_passphrase', 'same');
  const b = ef.encryptField('users', 'payfast_passphrase', 'same');
  assert.notStrictEqual(a, b, 'random IV should make these differ');
  // ...which is exactly why an encrypted column can never carry a UNIQUE index.
  assert.strictEqual(ef.decryptField('users', 'payfast_passphrase', a), 'same');
  assert.strictEqual(ef.decryptField('users', 'payfast_passphrase', b), 'same');
});

test('round-trips unicode and long values', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  for (const value of ['Café ☕ — naïve', 'x'.repeat(500), '{"json":"ish"}', ' leading and trailing ']) {
    const envelope = ef.encryptField('users', 'payfast_merchant_key', value);
    assert.strictEqual(ef.decryptField('users', 'payfast_merchant_key', envelope), value);
  }
});

test('a 40-character passphrase fits comfortably in varchar(512)', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  const envelope = ef.encryptField('users', 'payfast_passphrase', 'x'.repeat(40));
  assert.ok(envelope.length < 512, `envelope was ${envelope.length} chars`);
});

// ─── Empty and pass-through values ────────────────────────────────────────────

test('null, undefined and empty string pass through unencrypted', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  for (const value of [null, undefined, '']) {
    assert.strictEqual(ef.encryptField('users', 'payfast_passphrase', value), value);
  }
});

test('decryptField passes through anything that is not an envelope', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  // Mandatory for the POPIA backfill: deployed code must read plaintext and
  // ciphertext identically while the backfill is mid-flight.
  for (const value of ['plaintext', '', null, undefined, 12345]) {
    assert.strictEqual(ef.decryptField('users', 'payfast_passphrase', value), value);
  }
});

// ─── AAD binding ──────────────────────────────────────────────────────────────

test('a value moved to another column fails to decrypt', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  const envelope = ef.encryptField('users', 'payfast_passphrase', 'secret');
  assert.throws(() => ef.decryptField('users', 'payfast_merchant_key', envelope));
});

test('a value moved to another table fails to decrypt', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  const envelope = ef.encryptField('users', 'payfast_passphrase', 'secret');
  assert.throws(() => ef.decryptField('customers', 'payfast_passphrase', envelope));
});

// ─── Tampering ────────────────────────────────────────────────────────────────

test('a tampered envelope fails the auth tag', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  const envelope = ef.encryptField('users', 'payfast_passphrase', 'secret');
  const flipped = envelope.slice(0, -2) + (envelope.slice(-2) === 'AA' ? 'AB' : 'AA');
  assert.throws(() => ef.decryptField('users', 'payfast_passphrase', flipped));
});

test('a truncated envelope is rejected', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  assert.throws(() => ef.decryptField('users', 'payfast_passphrase', 'fv1.1$AAAA'), /Truncated/);
});

test('an envelope with no $ separator is rejected', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  assert.throws(() => ef.decryptField('users', 'payfast_passphrase', 'fv1.1nodollar'), /Malformed/);
});

// ─── Key rotation ─────────────────────────────────────────────────────────────

test('a row written under an old key still reads after rotation', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  const underKey1 = ef.encryptField('users', 'payfast_passphrase', 'old-secret');

  // Rotate: key 2 becomes active, key 1 stays in the ring for reads.
  process.env.DATA_ENCRYPTION_KEYS = `1:${KEY_1},2:${KEY_2}`;
  process.env.DATA_ENCRYPTION_KEY_ACTIVE = '2';
  ef.resetKeyringCache();

  assert.strictEqual(ef.decryptField('users', 'payfast_passphrase', underKey1), 'old-secret');
  const underKey2 = ef.encryptField('users', 'payfast_passphrase', 'new-secret');
  assert.match(underKey2, /^fv1\.2\$/, 'new writes should use the active key');
  assert.strictEqual(ef.decryptField('users', 'payfast_passphrase', underKey2), 'new-secret');
});

test('dropping a key that rows still reference gives a pointed error', (t) => {
  withKeyring(t, `1:${KEY_1},2:${KEY_2}`, '1');
  const underKey1 = ef.encryptField('users', 'payfast_passphrase', 'secret');

  process.env.DATA_ENCRYPTION_KEYS = `2:${KEY_2}`;
  process.env.DATA_ENCRYPTION_KEY_ACTIVE = '2';
  ef.resetKeyringCache();

  assert.throws(
    () => ef.decryptField('users', 'payfast_passphrase', underKey1),
    /encrypted with key "1".*not in DATA_ENCRYPTION_KEYS/s
  );
});

test('the wrong key of the right length fails loudly', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  const envelope = ef.encryptField('users', 'payfast_passphrase', 'secret');

  // Same key id, different material — the exact "fresh box, fresh key" scenario
  // the canary exists to catch at boot.
  process.env.DATA_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString('base64')}`;
  ef.resetKeyringCache();

  assert.throws(() => ef.decryptField('users', 'payfast_passphrase', envelope));
});

// ─── Keyring validation ───────────────────────────────────────────────────────

test('no keyring means encryption is simply unavailable, not an error', (t) => {
  withKeyring(t, null);
  assert.strictEqual(ef.isEncryptionConfigured(), false);
  assert.throws(
    () => ef.encryptField('users', 'payfast_passphrase', 'x'),
    (err) => err.code === 'ENCRYPTION_UNAVAILABLE'
  );
});

test('a keyring that is present is validated strictly', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');

  const badKeyrings = [
    ['a key that is too short', `1:${crypto.randomBytes(16).toString('base64')}`, /decodes to 16 bytes/],
    ['a key that is too long', `1:${crypto.randomBytes(64).toString('base64')}`, /decodes to 64 bytes/],
    ['a passphrase instead of a key', '1:hunter2', /decodes to .* bytes/],
    ['a missing colon', 'justsomebase64', /not in <id>:<base64> form/],
    ['a duplicate key id', `1:${KEY_1},1:${KEY_2}`, /appears more than once/],
    ['a non-alphanumeric id', `a b:${KEY_1}`, /must be alphanumeric/],
  ];

  for (const [label, keyring, pattern] of badKeyrings) {
    process.env.DATA_ENCRYPTION_KEYS = keyring;
    ef.resetKeyringCache();
    assert.throws(() => ef.isEncryptionConfigured(), pattern, `expected rejection: ${label}`);
  }
});

test('DATA_ENCRYPTION_KEY_ACTIVE must name a key in the ring', (t) => {
  withKeyring(t, `1:${KEY_1}`, '9');
  assert.throws(() => ef.isEncryptionConfigured(), /names a key that is not in DATA_ENCRYPTION_KEYS/);
});

test('the active key defaults to the first when unset', (t) => {
  withKeyring(t, `7:${KEY_1}`, undefined);
  assert.match(ef.encryptField('users', 'payfast_passphrase', 'x'), /^fv1\.7\$/);
});

// ─── Row mappers ──────────────────────────────────────────────────────────────

test('decryptRow only touches registered columns', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  const row = {
    id: 7,
    email: 'kyle@example.com',
    company_name: 'Acme',
    payfast_merchant_id: ef.encryptField('users', 'payfast_merchant_id', '10000100'),
    payfast_passphrase: ef.encryptField('users', 'payfast_passphrase', 'jt7NOE43FZPn'),
  };
  const decrypted = ef.decryptUserRow(row);

  assert.strictEqual(decrypted.payfast_merchant_id, '10000100');
  assert.strictEqual(decrypted.payfast_passphrase, 'jt7NOE43FZPn');
  assert.strictEqual(decrypted.email, 'kyle@example.com', 'unregistered columns must be untouched');
  assert.strictEqual(decrypted.company_name, 'Acme');
  assert.strictEqual(decrypted.id, 7);
});

test('decryptRow ignores columns the query did not select', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  // Narrow SELECTs are the common case; absent keys must not become undefined.
  const decrypted = ef.decryptUserRow({ id: 7, company_name: 'Acme' });
  assert.deepStrictEqual(decrypted, { id: 7, company_name: 'Acme' });
  assert.ok(!('payfast_passphrase' in decrypted));
});

test('decryptRow does not mutate its input', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  const envelope = ef.encryptField('users', 'payfast_passphrase', 'secret');
  const row = { payfast_passphrase: envelope };
  ef.decryptUserRow(row);
  assert.strictEqual(row.payfast_passphrase, envelope);
});

test('encryptRow/decryptRow are inverses', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  const input = { payfast_merchant_id: '10000100', payfast_merchant_key: '46f0cd694581a', company_name: 'Acme' };
  const stored = ef.encryptUserInput(input);

  assert.ok(ef.isEnvelope(stored.payfast_merchant_id));
  assert.strictEqual(stored.company_name, 'Acme', 'unregistered columns pass through');
  assert.deepStrictEqual(ef.decryptUserRow(stored), input);
});

test('an unregistered table passes through untouched', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  const row = { transaction_reference: 'plain' };
  assert.deepStrictEqual(ef.decryptRow('payments', row), row);
});

test('null rows survive the mappers', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  assert.strictEqual(ef.decryptUserRow(null), null);
  assert.strictEqual(ef.decryptUserRow(undefined), undefined);
});

// ─── Registry shape ───────────────────────────────────────────────────────────

test('the registry covers exactly the three PayFast columns for now', () => {
  assert.deepStrictEqual(Object.keys(ef.REGISTRY), ['users']);
  assert.deepStrictEqual([...ef.REGISTRY.users], [
    'payfast_merchant_id', 'payfast_merchant_key', 'payfast_passphrase',
  ]);
});
