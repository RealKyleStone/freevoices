/**
 * Tests for the PayFast signature and ITN logic.
 *
 * Run with:  node --test test/
 *
 * Deliberately in a top-level test/ directory rather than beside the service.
 * scripts/build-deploy-bundle.js ships the whole of src/services/ and derives
 * the production dependency list by regexing require() calls out of every
 * staged .js file, exiting 1 when one is not in package.json. `node:test` is
 * not in that list, so a test file living in src/services/ would break the
 * deploy build. Nothing here is ever shipped.
 */

const test = require('node:test');
const assert = require('node:assert');

const pf = require('../src/services/payfast.service');

// ─── pfUrlEncode ──────────────────────────────────────────────────────────────

test('pfUrlEncode matches PHP urlencode()', async (t) => {
  // Expected values are what PHP's urlencode() produces. The distinction that
  // matters: urlencode() escapes ~ to %7E, rawurlencode() does not. PayFast
  // uses urlencode.
  const cases = [
    ['hello world', 'hello+world'],
    ['A & B', 'A+%26+B'],
    ['a+b', 'a%2Bb'],
    ['~', '%7E'],
    ['!', '%21'],
    ["'", '%27'],
    ['(', '%28'],
    [')', '%29'],
    ['*', '%2A'],
    ['/', '%2F'],
    ['100%', '100%25'],
    ['https://example.com/a b', 'https%3A%2F%2Fexample.com%2Fa+b'],
    [
      "A & B + C ~ D! (E) 'F' *G* /H/ 100%",
      'A+%26+B+%2B+C+%7E+D%21+%28E%29+%27F%27+%2AG%2A+%2FH%2F+100%25',
    ],
  ];

  for (const [input, expected] of cases) {
    await t.test(JSON.stringify(input), () => {
      assert.strictEqual(pf.pfUrlEncode(input), expected);
    });
  }
});

test('pfUrlEncode emits uppercase hex', () => {
  // PayFast requires %3A%2F%2F, not %3a%2f%2f. encodeURIComponent already does
  // this, but a future "optimisation" to a hand-rolled encoder might not.
  assert.strictEqual(pf.pfUrlEncode('://'), '%3A%2F%2F');
});

test('pfUrlEncode trims surrounding whitespace before encoding', () => {
  assert.strictEqual(pf.pfUrlEncode('  padded  '), 'padded');
});

// ─── Signature string construction ────────────────────────────────────────────

test('buildSignatureString uses PayFast field order, not object key order', () => {
  // Object literal deliberately in the wrong order.
  const data = {
    amount: '100.00',
    merchant_id: '10000100',
    item_name: 'Test',
    merchant_key: '46f0cd694581a',
  };
  assert.strictEqual(
    pf.buildSignatureString(data, ''),
    'merchant_id=10000100&merchant_key=46f0cd694581a&amount=100.00&item_name=Test'
  );
});

test('buildSignatureString drops blank values', () => {
  const data = {
    merchant_id: '10000100',
    merchant_key: 'key',
    return_url: '',
    cancel_url: null,
    notify_url: undefined,
    name_first: '   ',
    amount: '100.00',
    item_name: 'Test',
  };
  assert.strictEqual(
    pf.buildSignatureString(data, ''),
    'merchant_id=10000100&merchant_key=key&amount=100.00&item_name=Test'
  );
});

test('buildSignatureString appends the passphrase last', () => {
  const data = { merchant_id: '1', merchant_key: '2' };
  assert.strictEqual(
    pf.buildSignatureString(data, 'jt7NOE43FZPn'),
    'merchant_id=1&merchant_key=2&passphrase=jt7NOE43FZPn'
  );
});

test('buildSignatureString omits the passphrase entirely when blank', () => {
  const data = { merchant_id: '1' };
  assert.strictEqual(pf.buildSignatureString(data, ''), 'merchant_id=1');
  assert.strictEqual(pf.buildSignatureString(data, null), 'merchant_id=1');
});

test('buildSignatureString never emits a passphrase= pair from the field order array', () => {
  // Guards against someone adding 'passphrase' to PAYFAST_SIGNATURE_FIELD_ORDER,
  // which would append it twice and break every signature.
  assert.ok(!pf.PAYFAST_SIGNATURE_FIELD_ORDER.includes('passphrase'));
});

test('generateSignature is lowercase 32-char hex', () => {
  const sig = pf.generateSignature({ merchant_id: '10000100' }, 'jt7NOE43FZPn');
  assert.match(sig, /^[0-9a-f]{32}$/);
});

test('generateSignature is sensitive to the passphrase', () => {
  const data = { merchant_id: '10000100', amount: '100.00' };
  assert.notStrictEqual(pf.generateSignature(data, 'a'), pf.generateSignature(data, 'b'));
});

// ─── Building the form ────────────────────────────────────────────────────────

const SANDBOX_USER = {
  id: 7,
  company_name: 'Acme Trading',
  payfast_merchant_id: '10000100',
  payfast_merchant_key: '46f0cd694581a',
  payfast_passphrase: 'jt7NOE43FZPn',
  payfast_enabled: 1,
};

const INVOICE = {
  id: 42,
  user_id: 7,
  document_number: 'INV-2026-0001',
  total: '1234.50',
  status: 'SENT',
  currency_code: 'ZAR',
};

const URLS = {
  returnUrl: 'https://freevoices.co.za/pay/abc123/return',
  cancelUrl: 'https://freevoices.co.za/pay/abc123/cancelled',
  notifyUrl: 'https://freevoices.co.za/payfast/itn',
};

test('buildPaymentForm puts signature last and signs everything before it', () => {
  const { fields } = pf.buildPaymentForm({ invoice: INVOICE, user: SANDBOX_USER, urls: URLS });

  assert.strictEqual(fields[fields.length - 1].name, 'signature');

  const signed = {};
  for (const { name, value } of fields.slice(0, -1)) signed[name] = value;
  assert.strictEqual(
    fields[fields.length - 1].value,
    pf.generateSignature(signed, SANDBOX_USER.payfast_passphrase)
  );
});

test('buildPaymentForm never includes the signature in the signed data', () => {
  const { fields } = pf.buildPaymentForm({ invoice: INVOICE, user: SANDBOX_USER, urls: URLS });
  const names = fields.slice(0, -1).map((f) => f.name);
  assert.ok(!names.includes('signature'));
});

test('buildPaymentForm carries the invoice id as m_payment_id', () => {
  const { fields } = pf.buildPaymentForm({ invoice: INVOICE, user: SANDBOX_USER, urls: URLS });
  const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]));
  assert.strictEqual(byName.m_payment_id, '42');
  assert.strictEqual(byName.custom_str1, '7');
  assert.strictEqual(byName.custom_str2, 'INV-2026-0001');
});

test('buildPaymentForm formats the amount to two decimals', () => {
  const byName = Object.fromEntries(
    pf.buildPaymentForm({ invoice: { ...INVOICE, total: 1234.5 }, user: SANDBOX_USER, urls: URLS })
      .fields.map((f) => [f.name, f.value])
  );
  assert.strictEqual(byName.amount, '1234.50');
});

test('buildPaymentForm emits fields in signing order', () => {
  const { fields } = pf.buildPaymentForm({ invoice: INVOICE, user: SANDBOX_USER, urls: URLS });
  const names = fields.slice(0, -1).map((f) => f.name);
  const expectedOrder = pf.PAYFAST_SIGNATURE_FIELD_ORDER.filter((n) => names.includes(n));
  assert.deepStrictEqual(names, expectedOrder);
});

test('buildPaymentForm posts to sandbox or live per mode', () => {
  assert.strictEqual(
    pf.buildPaymentForm({ invoice: INVOICE, user: SANDBOX_USER, urls: URLS, mode: 'sandbox' }).action,
    'https://sandbox.payfast.co.za/eng/process'
  );
  assert.strictEqual(
    pf.buildPaymentForm({ invoice: INVOICE, user: SANDBOX_USER, urls: URLS, mode: 'live' }).action,
    'https://www.payfast.co.za/eng/process'
  );
});

test('never sends custom_int fields', () => {
  // PHP empty() drops "0", so a custom_int of zero would be in our signature
  // and absent from PayFast's. We avoid the class of bug by not using them.
  const { fields } = pf.buildPaymentForm({ invoice: INVOICE, user: SANDBOX_USER, urls: URLS });
  assert.ok(!fields.some((f) => f.name.startsWith('custom_int')));
});

// ─── item_name sanitisation ───────────────────────────────────────────────────

test('sanitiseItemText strips non-ASCII and truncates', () => {
  assert.strictEqual(pf.sanitiseItemText('Café — Ltd', 100), 'Caf Ltd');
  assert.strictEqual(pf.sanitiseItemText('abcdefghij', 5), 'abcde');
  assert.strictEqual(pf.sanitiseItemText(null, 10), '');
});

test('item_name is capped at PayFast\'s 100 character limit', () => {
  const user = { ...SANDBOX_USER, company_name: 'X'.repeat(200) };
  const byName = Object.fromEntries(
    pf.buildPaymentForm({ invoice: INVOICE, user, urls: URLS }).fields.map((f) => [f.name, f.value])
  );
  assert.strictEqual(byName.item_name.length, 100);
});

// ─── Eligibility ──────────────────────────────────────────────────────────────

test('isPayfastEligible accepts a well-formed ZAR invoice', () => {
  assert.strictEqual(pf.isPayfastEligible({ invoice: INVOICE, user: SANDBOX_USER }), true);
});

test('isPayfastEligible rejects on each individual ground', () => {
  const rejects = [
    ['disabled', { user: { ...SANDBOX_USER, payfast_enabled: 0 } }],
    ['no merchant id', { user: { ...SANDBOX_USER, payfast_merchant_id: null } }],
    ['no merchant key', { user: { ...SANDBOX_USER, payfast_merchant_key: '' } }],
    ['no passphrase', { user: { ...SANDBOX_USER, payfast_passphrase: null } }],
    ['already paid', { invoice: { ...INVOICE, status: 'PAID' } }],
    ['cancelled', { invoice: { ...INVOICE, status: 'CANCELLED' } }],
    ['draft', { invoice: { ...INVOICE, status: 'DRAFT' } }],
    ['non-ZAR', { invoice: { ...INVOICE, currency_code: 'USD' } }],
    ['below R5 minimum', { invoice: { ...INVOICE, total: '4.99' } }],
  ];
  for (const [label, override] of rejects) {
    const result = pf.isPayfastEligible({ invoice: INVOICE, user: SANDBOX_USER, ...override });
    assert.strictEqual(result, false, `expected rejection: ${label}`);
  }
});

test('isPayfastEligible treats a missing currency as ZAR', () => {
  const invoice = { ...INVOICE };
  delete invoice.currency_code;
  assert.strictEqual(pf.isPayfastEligible({ invoice, user: SANDBOX_USER }), true);
});

test('isPayfastEligible accepts exactly the R5.00 minimum', () => {
  assert.strictEqual(
    pf.isPayfastEligible({ invoice: { ...INVOICE, total: '5.00' }, user: SANDBOX_USER }),
    true
  );
});

// ─── ITN parameter string ─────────────────────────────────────────────────────

test('itnParamStringFromRaw slices everything before signature', () => {
  const raw = 'm_payment_id=42&pf_payment_id=1089250&payment_status=COMPLETE&signature=abc123';
  assert.strictEqual(
    pf.itnParamStringFromRaw(raw),
    'm_payment_id=42&pf_payment_id=1089250&payment_status=COMPLETE'
  );
});

test('itnParamStringFromRaw preserves PayFast\'s own encoding verbatim', () => {
  // The whole reason for slicing the raw body: no re-encoding, so no chance of
  // disagreeing with PayFast about how a space or a tilde was escaped.
  const raw = 'item_name=Invoice+INV-1+%7E+Acme&amount=100.00&signature=deadbeef';
  assert.strictEqual(
    pf.itnParamStringFromRaw(raw),
    'item_name=Invoice+INV-1+%7E+Acme&amount=100.00'
  );
});

test('itnParamStringFromRaw returns null without a signature pair', () => {
  assert.strictEqual(pf.itnParamStringFromRaw('a=1&b=2'), null);
  assert.strictEqual(pf.itnParamStringFromRaw(''), null);
  assert.strictEqual(pf.itnParamStringFromRaw(null), null);
});

test('itnParamStringFromRaw is not fooled by a field ending in "signature"', () => {
  const raw = 'my_signature=x&amount=100.00&signature=abc';
  assert.strictEqual(pf.itnParamStringFromRaw(raw), 'my_signature=x&amount=100.00');
});

// ─── ITN signature verification ───────────────────────────────────────────────

const PASSPHRASE = 'jt7NOE43FZPn';

function signItn(paramString, passphrase) {
  return require('node:crypto')
    .createHash('md5')
    .update(`${paramString}&passphrase=${pf.pfUrlEncode(passphrase)}`, 'utf8')
    .digest('hex');
}

test('verifyItnSignature accepts a genuine notification', () => {
  const params = 'm_payment_id=42&pf_payment_id=1089250&payment_status=COMPLETE&amount_gross=100.00';
  const signature = signItn(params, PASSPHRASE);
  const result = pf.verifyItnSignature(`${params}&signature=${signature}`, { signature }, PASSPHRASE);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.source, 'raw');
});

test('verifyItnSignature rejects a tampered amount', () => {
  const params = 'm_payment_id=42&pf_payment_id=1089250&payment_status=COMPLETE&amount_gross=100.00';
  const signature = signItn(params, PASSPHRASE);
  const tampered = params.replace('100.00', '1.00');
  const result = pf.verifyItnSignature(`${tampered}&signature=${signature}`, { signature }, PASSPHRASE);
  assert.strictEqual(result.valid, false);
});

test('verifyItnSignature rejects the wrong passphrase', () => {
  const params = 'm_payment_id=42&payment_status=COMPLETE';
  const signature = signItn(params, PASSPHRASE);
  const result = pf.verifyItnSignature(`${params}&signature=${signature}`, { signature }, 'wrong-one');
  assert.strictEqual(result.valid, false);
});

test('verifyItnSignature refuses when the seller has no passphrase', () => {
  const result = pf.verifyItnSignature('a=1&signature=' + 'a'.repeat(32), { signature: 'a'.repeat(32) }, '');
  assert.deepStrictEqual(result, { valid: false, source: 'no-passphrase' });
});

test('verifyItnSignature rejects a malformed signature without throwing', () => {
  // timingSafeEqual throws on a length mismatch, so the shape is checked first.
  for (const bad of ['', 'short', 'z'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)]) {
    const result = pf.verifyItnSignature(`a=1&signature=${bad}`, { signature: bad }, PASSPHRASE);
    assert.strictEqual(result.valid, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test('verifyItnSignature accepts an uppercase signature', () => {
  const params = 'm_payment_id=42';
  const signature = signItn(params, PASSPHRASE).toUpperCase();
  const result = pf.verifyItnSignature(`${params}&signature=${signature}`, { signature }, PASSPHRASE);
  assert.strictEqual(result.valid, true);
});

// ─── Source IP ────────────────────────────────────────────────────────────────

test('isPayfastIp accepts addresses inside each published range', () => {
  const inside = [
    '197.97.145.144', '197.97.145.150', '197.97.145.159',   // /28
    '41.74.179.192', '41.74.179.200', '41.74.179.223',      // /27
    '102.216.36.0', '102.216.36.15',                        // /28
    '102.216.36.128', '102.216.36.143',                     // /28
    '144.126.193.139',                                      // /32
  ];
  for (const ip of inside) {
    assert.strictEqual(pf.isPayfastIp(ip), true, `expected ${ip} to be allowed`);
  }
});

test('isPayfastIp rejects addresses just outside each range', () => {
  const outside = [
    '197.97.145.143', '197.97.145.160',
    '41.74.179.191', '41.74.179.224',
    '102.216.36.16', '102.216.36.127', '102.216.36.144',
    '144.126.193.138', '144.126.193.140',
    '8.8.8.8', '127.0.0.1',
  ];
  for (const ip of outside) {
    assert.strictEqual(pf.isPayfastIp(ip), false, `expected ${ip} to be rejected`);
  }
});

test('isPayfastIp strips the ::ffff: IPv4-mapped prefix', () => {
  // Node reports an IPv4 client as ::ffff:a.b.c.d on a dual-stack socket.
  // Missing this rejects every single notification.
  assert.strictEqual(pf.isPayfastIp('::ffff:197.97.145.150'), true);
  assert.strictEqual(pf.isPayfastIp('::FFFF:197.97.145.150'), true);
  assert.strictEqual(pf.isPayfastIp('::ffff:8.8.8.8'), false);
});

test('isPayfastIp rejects junk without throwing', () => {
  for (const bad of ['', null, undefined, 'not-an-ip', '1.2.3', '1.2.3.4.5', '999.1.1.1', '::1']) {
    assert.strictEqual(pf.isPayfastIp(bad), false, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test('PAYFAST_ALLOWED_IPS overrides the built-in list', (t) => {
  const original = process.env.PAYFAST_ALLOWED_IPS;
  t.after(() => {
    if (original === undefined) delete process.env.PAYFAST_ALLOWED_IPS;
    else process.env.PAYFAST_ALLOWED_IPS = original;
  });

  process.env.PAYFAST_ALLOWED_IPS = '10.0.0.0/8, 192.168.1.1';
  assert.strictEqual(pf.isPayfastIp('10.4.5.6'), true);
  assert.strictEqual(pf.isPayfastIp('192.168.1.1'), true);
  assert.strictEqual(pf.isPayfastIp('197.97.145.150'), false, 'override should replace, not extend');
});

// ─── URLs ─────────────────────────────────────────────────────────────────────

test('payfastUrls selects the right host', () => {
  assert.deepStrictEqual(pf.payfastUrls('sandbox'), {
    sandbox: true,
    process: 'https://sandbox.payfast.co.za/eng/process',
    validate: 'https://sandbox.payfast.co.za/eng/query/validate',
  });
  assert.deepStrictEqual(pf.payfastUrls('live'), {
    sandbox: false,
    process: 'https://www.payfast.co.za/eng/process',
    validate: 'https://www.payfast.co.za/eng/query/validate',
  });
});

test('payfastUrls defaults to live', () => {
  const original = process.env.PAYFAST_MODE;
  delete process.env.PAYFAST_MODE;
  try {
    assert.strictEqual(pf.payfastUrls().sandbox, false);
  } finally {
    if (original !== undefined) process.env.PAYFAST_MODE = original;
  }
});

// ─── Redaction ────────────────────────────────────────────────────────────────

test('redactPayfast hides every secret-bearing field', () => {
  const redacted = pf.redactPayfast({
    merchant_id: '10000100',
    merchant_key: '46f0cd694581a',
    passphrase: 'jt7NOE43FZPn',
    signature: 'abc',
    amount: '100.00',
  });
  assert.strictEqual(redacted.merchant_id, '10000100');
  assert.strictEqual(redacted.amount, '100.00');
  assert.strictEqual(redacted.merchant_key, '[redacted]');
  assert.strictEqual(redacted.passphrase, '[redacted]');
  assert.strictEqual(redacted.signature, '[redacted]');
});
