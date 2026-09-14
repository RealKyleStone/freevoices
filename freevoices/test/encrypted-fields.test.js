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
    ['a missing colon', 'justsomebase64', /has no key id/],
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

test('the registry covers exactly the POPIA phase 6 scope', () => {
  // Pinned so that adding a column without widening it in a migration, or
  // without wiring its call sites, shows up as a failing test rather than as
  // truncated ciphertext in production.
  assert.deepStrictEqual(Object.keys(ef.REGISTRY).sort(),
    ['customers', 'document_tracking', 'payments', 'users']);

  assert.deepStrictEqual([...ef.REGISTRY.users], [
    'payfast_merchant_id', 'payfast_merchant_key', 'payfast_passphrase',
    'bank_account_number', 'bank_branch_code', 'bank_account_type',
    'vat_number', 'company_registration', 'phone', 'address',
  ]);
  assert.deepStrictEqual([...ef.REGISTRY.customers],
    ['phone', 'vat_number', 'billing_address', 'shipping_address', 'notes']);
  assert.deepStrictEqual([...ef.REGISTRY.document_tracking], ['ip_address', 'user_agent']);
  assert.deepStrictEqual([...ef.REGISTRY.payments], ['transaction_reference']);
});

test('identifying columns stay OUT of the registry', () => {
  // Encrypting any of these silently breaks customer search, ORDER BY name,
  // pagination and the report endpoints, because random IVs make every row's
  // ciphertext unique. This test is the guard rail on that decision.
  assert.ok(!ef.REGISTRY.users.includes('email'));
  assert.ok(!ef.REGISTRY.customers.includes('name'));
  assert.ok(!ef.REGISTRY.customers.includes('email'));
});

// ─── Per-table mappers ────────────────────────────────────────────────────────

test('decryptCustomerRow round-trips every registered customers column', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  const input = {
    id: 3,
    name: 'Acme Buyer',
    email: 'buyer@example.com',
    phone: '+27 82 000 0000',
    vat_number: '4123456789',
    billing_address: '1 Long Street, Cape Town',
    shipping_address: '2 Short Street, Cape Town',
    notes: 'Pays late.',
  };
  const stored = ef.encryptCustomerInput(input);

  assert.ok(ef.isEnvelope(stored.phone));
  assert.ok(ef.isEnvelope(stored.notes));
  assert.strictEqual(stored.name, 'Acme Buyer', 'name must stay searchable');
  assert.strictEqual(stored.email, 'buyer@example.com', 'email must stay searchable');
  assert.deepStrictEqual(ef.decryptCustomerRow(stored), input);
});

test('decryptPaymentRow and decryptTrackingRow work on their own tables', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');

  const payment = ef.encryptRow('payments', { id: 1, amount: '100.00', transaction_reference: 'PF-12345' });
  assert.ok(ef.isEnvelope(payment.transaction_reference));
  assert.strictEqual(payment.amount, '100.00', 'money columns are never encrypted');
  assert.strictEqual(ef.decryptPaymentRow(payment).transaction_reference, 'PF-12345');

  const tracking = ef.encryptRow('document_tracking', {
    event_type: 'VIEWED', ip_address: '102.65.1.1', user_agent: 'Mozilla/5.0',
  });
  assert.ok(ef.isEnvelope(tracking.ip_address));
  assert.strictEqual(tracking.event_type, 'VIEWED');
  const back = ef.decryptTrackingRow(tracking);
  assert.strictEqual(back.ip_address, '102.65.1.1');
  assert.strictEqual(back.user_agent, 'Mozilla/5.0');
});

// ─── Aliased joins ────────────────────────────────────────────────────────────

test('decryptCustomerJoin handles the customer_ prefix', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  // What `c.billing_address AS customer_billing_address` produces.
  const row = {
    document_number: 'INV-1',
    customer_name: 'Acme Buyer',
    customer_billing_address: ef.encryptField('customers', 'billing_address', '1 Long Street'),
    customer_vat_number: ef.encryptField('customers', 'vat_number', '4123456789'),
  };
  const out = ef.decryptCustomerJoin(row);
  assert.strictEqual(out.customer_billing_address, '1 Long Street');
  assert.strictEqual(out.customer_vat_number, '4123456789');
  assert.strictEqual(out.customer_name, 'Acme Buyer');
  assert.strictEqual(out.document_number, 'INV-1');
});

test('decryptInvoiceJoin handles seller and customer columns in one row', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  // The real shape: documents columns, the seller's users columns unaliased,
  // and the customer's columns under customer_.
  const row = {
    id: 8,
    total: '6999.99',
    address: ef.encryptField('users', 'address', '10 Seller Road'),
    bank_account_number: ef.encryptField('users', 'bank_account_number', '1234567890'),
    phone: ef.encryptField('users', 'phone', '+27 21 000 0000'),
    customer_billing_address: ef.encryptField('customers', 'billing_address', '1 Buyer Lane'),
  };
  const out = ef.decryptInvoiceJoin(row);
  assert.strictEqual(out.address, '10 Seller Road');
  assert.strictEqual(out.bank_account_number, '1234567890');
  assert.strictEqual(out.phone, '+27 21 000 0000');
  assert.strictEqual(out.customer_billing_address, '1 Buyer Lane');
  assert.strictEqual(out.total, '6999.99');
});

test('a customers value decrypted as a users value fails loudly', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  // phone, vat_number and notes all exist on more than one table. Binding the
  // table into the AAD is what turns "wrong mapper at a call site" from silent
  // corruption into an exception.
  const customerPhone = ef.encryptField('customers', 'phone', '+27 82 000 0000');
  assert.throws(() => ef.decryptUserRow({ phone: customerPhone }));

  const userPhone = ef.encryptField('users', 'phone', '+27 21 000 0000');
  assert.throws(() => ef.decryptCustomerRow({ phone: userPhone }));
});

test('mappers are safe to compose and to apply twice', (t) => {
  withKeyring(t, `1:${KEY_1}`, '1');
  // Decrypted output contains no envelopes, so a second pass is a no-op. This
  // is what makes it safe to be generous with mappers at call sites.
  const row = { phone: ef.encryptField('users', 'phone', '+27 21 000 0000') };
  const once = ef.decryptUserRow(row);
  const twice = ef.decryptUserRow(once);
  assert.deepStrictEqual(twice, once);
  assert.strictEqual(twice.phone, '+27 21 000 0000');
});
