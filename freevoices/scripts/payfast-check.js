#!/usr/bin/env node
/**
 * Verify the PayFast signature logic without a database, a server, or a card.
 *
 *   node scripts/payfast-check.js          # offline checks only
 *   node scripts/payfast-check.js --live   # also postback to the PayFast sandbox
 *
 * Why this exists alongside test/payfast.service.test.js: `npm run doctor` is
 * this repo's real server-side verification mechanism, and the deploy target is
 * a cPanel host where `node --test` is awkward to reach. This runs anywhere
 * node does, needs no dev dependencies, and exits non-zero on failure so it can
 * gate a deploy.
 *
 * ── About the pinned signature ──────────────────────────────────────────────
 *
 * PIN_EXPECTED_SIGNATURE below is a REGRESSION pin, not an authority pin: it
 * was computed by this implementation, so it proves the encoder has not
 * changed, NOT that PayFast agrees with it. PayFast publishes no signed test
 * vector to check against.
 *
 * The authority check is a real sandbox transaction (see the plan's phase E).
 * Once one has been through successfully, this pin is known-good and any future
 * refactor that changes it has broken something. Until then, treat a passing
 * run here as "unchanged", not as "correct".
 */

const pf = require('../src/services/payfast.service');

let failures = 0;
let checks = 0;

function check(label, actual, expected) {
  checks += 1;
  const ok = actual === expected;
  if (!ok) {
    failures += 1;
    console.error(`  FAIL  ${label}`);
    console.error(`        expected: ${JSON.stringify(expected)}`);
    console.error(`        actual:   ${JSON.stringify(actual)}`);
  }
  return ok;
}

function section(title) {
  console.log(`\n${title}`);
}

// ─── 1. Encoding, the part most likely to be silently wrong ───────────────────

section('URL encoding (must match PHP urlencode)');

const ENCODING_CASES = [
  ['hello world', 'hello+world'],
  ['A & B', 'A+%26+B'],
  ['a+b', 'a%2Bb'],
  ['~', '%7E'],   // urlencode escapes this; rawurlencode does not
  ['!', '%21'],
  ["'", '%27'],
  ['(', '%28'],
  [')', '%29'],
  ['*', '%2A'],
  ['://', '%3A%2F%2F'],   // uppercase hex, not %3a%2f%2f
  ['100%', '100%25'],
  ["A & B + C ~ D! (E) 'F' *G* /H/ 100%",
   'A+%26+B+%2B+C+%7E+D%21+%28E%29+%27F%27+%2AG%2A+%2FH%2F+100%25'],
];

for (const [input, expected] of ENCODING_CASES) {
  check(`urlencode(${JSON.stringify(input)})`, pf.pfUrlEncode(input), expected);
}
console.log(`  ${ENCODING_CASES.length} encoding cases`);

// ─── 2. Field order and blank handling ────────────────────────────────────────

section('Signature string construction');

check(
  'fields are ordered by PayFast order, not object key order',
  pf.buildSignatureString(
    { amount: '100.00', merchant_id: '10000100', item_name: 'Test', merchant_key: 'k' },
    ''
  ),
  'merchant_id=10000100&merchant_key=k&amount=100.00&item_name=Test'
);

check(
  'blank values are dropped',
  pf.buildSignatureString(
    { merchant_id: '1', return_url: '', cancel_url: null, notify_url: undefined, name_first: '  ', amount: '5.00' },
    ''
  ),
  'merchant_id=1&amount=5.00'
);

check(
  'passphrase is appended last and encoded',
  pf.buildSignatureString({ merchant_id: '1' }, 'a b&c'),
  'merchant_id=1&passphrase=a+b%26c'
);

check(
  'a blank passphrase adds nothing',
  pf.buildSignatureString({ merchant_id: '1' }, ''),
  'merchant_id=1'
);

check(
  'passphrase is not in the field order array (it would be appended twice)',
  pf.PAYFAST_SIGNATURE_FIELD_ORDER.includes('passphrase'),
  false
);

// ─── 3. The pinned vector ─────────────────────────────────────────────────────

section('Pinned signature vector (regression pin — see header)');

const PIN_FIELDS = {
  merchant_id: '10000100',
  merchant_key: '46f0cd694581a',
  return_url: 'https://freevoices.co.za/pay/TESTTOKEN/return',
  cancel_url: 'https://freevoices.co.za/pay/TESTTOKEN/cancelled',
  notify_url: 'https://freevoices.co.za/payfast/itn',
  m_payment_id: '42',
  amount: '1234.50',
  item_name: 'Invoice INV-2026-0001 - Acme Trading',
  item_description: 'Payment for invoice INV-2026-0001',
  custom_str1: '7',
  custom_str2: 'INV-2026-0001',
};
const PIN_PASSPHRASE = 'jt7NOE43FZPn';   // PayFast's published sandbox passphrase

const PIN_EXPECTED_STRING =
  'merchant_id=10000100&merchant_key=46f0cd694581a' +
  '&return_url=https%3A%2F%2Ffreevoices.co.za%2Fpay%2FTESTTOKEN%2Freturn' +
  '&cancel_url=https%3A%2F%2Ffreevoices.co.za%2Fpay%2FTESTTOKEN%2Fcancelled' +
  '&notify_url=https%3A%2F%2Ffreevoices.co.za%2Fpayfast%2Fitn' +
  '&m_payment_id=42&amount=1234.50' +
  '&item_name=Invoice+INV-2026-0001+-+Acme+Trading' +
  '&item_description=Payment+for+invoice+INV-2026-0001' +
  '&custom_str1=7&custom_str2=INV-2026-0001' +
  '&passphrase=jt7NOE43FZPn';

const PIN_EXPECTED_SIGNATURE = '29b2843b9efba25ee3f1607add55ef49';

check('pinned signature string', pf.buildSignatureString(PIN_FIELDS, PIN_PASSPHRASE), PIN_EXPECTED_STRING);
check('pinned signature md5', pf.generateSignature(PIN_FIELDS, PIN_PASSPHRASE), PIN_EXPECTED_SIGNATURE);

// ─── 4. The assembled form ────────────────────────────────────────────────────

section('Payment form assembly');

const FORM = pf.buildPaymentForm({
  invoice: {
    id: 42, user_id: 7, document_number: 'INV-2026-0001',
    total: '1234.50', status: 'SENT', currency_code: 'ZAR',
  },
  user: {
    id: 7, company_name: 'Acme Trading',
    payfast_merchant_id: '10000100', payfast_merchant_key: '46f0cd694581a',
    payfast_passphrase: PIN_PASSPHRASE, payfast_enabled: 1,
  },
  urls: {
    returnUrl: 'https://freevoices.co.za/pay/TESTTOKEN/return',
    cancelUrl: 'https://freevoices.co.za/pay/TESTTOKEN/cancelled',
    notifyUrl: 'https://freevoices.co.za/payfast/itn',
  },
  mode: 'sandbox',
});

check('posts to the sandbox endpoint', FORM.action, 'https://sandbox.payfast.co.za/eng/process');
check('signature is the last field', FORM.fields[FORM.fields.length - 1].name, 'signature');
check('assembled form reproduces the pinned signature', FORM.fields[FORM.fields.length - 1].value, PIN_EXPECTED_SIGNATURE);
check('no custom_int fields are sent', FORM.fields.some((f) => f.name.startsWith('custom_int')), false);
check(
  'rendered field order matches signing order',
  JSON.stringify(FORM.fields.slice(0, -1).map((f) => f.name)),
  JSON.stringify(pf.PAYFAST_SIGNATURE_FIELD_ORDER.filter((n) => FORM.fields.some((f) => f.name === n)))
);

// ─── 5. ITN verification ──────────────────────────────────────────────────────

section('ITN validation');

const ITN_PARAMS = 'm_payment_id=42&pf_payment_id=1089250&payment_status=COMPLETE&amount_gross=1234.50';
const ITN_SIGNATURE = require('crypto')
  .createHash('md5')
  .update(`${ITN_PARAMS}&passphrase=${pf.pfUrlEncode(PIN_PASSPHRASE)}`, 'utf8')
  .digest('hex');
const ITN_RAW = `${ITN_PARAMS}&signature=${ITN_SIGNATURE}`;

check('raw body is sliced at the signature field', pf.itnParamStringFromRaw(ITN_RAW), ITN_PARAMS);
check('a genuine notification verifies',
  pf.verifyItnSignature(ITN_RAW, { signature: ITN_SIGNATURE }, PIN_PASSPHRASE).valid, true);
check('a tampered amount is rejected',
  pf.verifyItnSignature(ITN_RAW.replace('1234.50', '1.00'), { signature: ITN_SIGNATURE }, PIN_PASSPHRASE).valid, false);
check('the wrong passphrase is rejected',
  pf.verifyItnSignature(ITN_RAW, { signature: ITN_SIGNATURE }, 'not-the-passphrase').valid, false);
check('a seller with no passphrase cannot verify anything',
  pf.verifyItnSignature(ITN_RAW, { signature: ITN_SIGNATURE }, '').valid, false);

section('ITN source addresses');

check('a published PayFast address is allowed', pf.isPayfastIp('197.97.145.150'), true);
// Node reports IPv4 clients as ::ffff:a.b.c.d on a dual-stack socket. Missing
// this rejects every notification PayFast ever sends.
check('IPv4-mapped IPv6 is handled', pf.isPayfastIp('::ffff:197.97.145.150'), true);
check('an outside address is rejected', pf.isPayfastIp('8.8.8.8'), false);
check('range boundaries are exact (low)', pf.isPayfastIp('197.97.145.143'), false);
check('range boundaries are exact (high)', pf.isPayfastIp('197.97.145.159'), true);
check('junk does not throw', pf.isPayfastIp('not-an-ip'), false);

// ─── 6. Secrets never reach a log ─────────────────────────────────────────────

section('Log redaction');

const redacted = pf.redactPayfast({ merchant_id: '10000100', merchant_key: 'secret', passphrase: 'secret', signature: 'abc' });
check('merchant_key is redacted', redacted.merchant_key, '[redacted]');
check('passphrase is redacted', redacted.passphrase, '[redacted]');
check('signature is redacted', redacted.signature, '[redacted]');
check('merchant_id is kept (not a secret)', redacted.merchant_id, '10000100');

// ─── 7. Optional live sandbox postback ────────────────────────────────────────

(async () => {
  if (process.argv.includes('--live')) {
    section('Live sandbox postback');
    try {
      // Expected to come back INVALID: this is a made-up transaction. The point
      // is to prove the endpoint is reachable and answers in the format we
      // parse — a DNS failure, a proxy, or a TLS problem shows up here rather
      // than during a real payment.
      const valid = await pf.validateItnWithPayfast(ITN_PARAMS, 'sandbox');
      console.log(`  reachable; sandbox answered ${valid ? 'VALID' : 'INVALID'} (INVALID is expected for a synthetic transaction)`);
    } catch (err) {
      failures += 1;
      console.error(`  FAIL  could not reach the PayFast sandbox: ${err.message}`);
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} of ${checks} checks FAILED.\n`);
    process.exit(1);
  }
  console.log(`All ${checks} PayFast checks passed.`);
  console.log('Note: the pinned signature proves the encoder is unchanged, not that PayFast agrees.');
  console.log('Confirm against a real sandbox payment before going live.\n');
  process.exit(0);
})();
