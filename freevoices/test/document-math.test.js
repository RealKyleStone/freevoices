/**
 * Tests for the invoice/quote money and date rules.
 *
 * Run with:  node --test test/
 *
 * Several cases come straight from the functional test report of
 * 20 October 2026 (F01, F03, F05, T14) so a regression names the finding.
 */

const test = require('node:test');
const assert = require('node:assert');

const m = require('../src/services/document-math');

test('roundCents rounds the decimal value half-up, not the binary one', () => {
  // T14: 1.5 x R99.99 = 149.985. toFixed(2) gives 149.98.
  assert.strictEqual(m.roundCents(1.5 * 99.99), 149.99);
  assert.strictEqual(m.roundCents(1.005), 1.01);
  assert.strictEqual(m.roundCents(0.125), 0.13);
  assert.strictEqual(m.roundCents(100), 100);
  assert.strictEqual(m.roundCents('22.4977'), 22.5);
  assert.strictEqual(m.roundCents(NaN), 0);
});

test('computeDocumentTotals rounds per line and sums the rounded lines', () => {
  const t = m.computeDocumentTotals([{ quantity: 1.5, unit_price: 99.99, vat_rate: 15 }]);
  assert.strictEqual(t.subtotal, 149.99);
  assert.strictEqual(t.vat_amount, 22.5);
  assert.strictEqual(t.total, 172.49);

  const two = m.computeDocumentTotals([
    { quantity: 2, unit_price: 100, vat_rate: 15 },
    { quantity: 10, unit_price: 100, vat_rate: 15 },
  ]);
  assert.deepStrictEqual([two.subtotal, two.vat_amount, two.total], [1200, 180, 1380]);
});

test('computeLine keeps a zero VAT rate and defaults a missing one to 15%', () => {
  assert.strictEqual(m.computeLine({ quantity: 1, unit_price: 100, vat_rate: 0 }).vat_amount, 0);
  assert.strictEqual(m.computeLine({ quantity: 1, unit_price: 100 }).vat_amount, 15);
});

test('resolveDueDate: explicit date wins, otherwise issue date + terms (F05)', () => {
  assert.strictEqual(m.resolveDueDate('2026-10-20', '2026-11-01', 30), '2026-11-01');
  assert.strictEqual(m.resolveDueDate('2026-10-20', '', 30), '2026-11-19');
  assert.strictEqual(m.resolveDueDate('2026-10-20', null, '30'), '2026-11-19');
  assert.strictEqual(m.resolveDueDate('2026-10-20', null, 0), '2026-10-20');
  assert.strictEqual(m.resolveDueDate('2026-10-20', null, null), null);
  assert.strictEqual(m.resolveDueDate('2026-10-20', null, ''), null);
  // Month and year rollover.
  assert.strictEqual(m.resolveDueDate('2026-12-15', null, 30), '2027-01-14');
});

test('todayIso is the Johannesburg calendar day, not the UTC one', () => {
  // 23:30 UTC on 19 Oct is 01:30 SAST on 20 Oct.
  assert.strictEqual(m.todayIso(new Date('2026-10-19T23:30:00Z')), '2026-10-20');
  assert.strictEqual(m.todayIso(new Date('2026-10-20T12:00:00Z')), '2026-10-20');
});

test('formatDisplayDate never moves a date-only value to the previous day (F03)', () => {
  const out = m.formatDisplayDate('2026-10-20');
  assert.match(out, /20/);
  assert.doesNotMatch(out, /19/);
  assert.strictEqual(m.formatDisplayDate(null), '—');
});

test('balanceDue and isSettled: R400 against R1,150 leaves R750 (F01)', () => {
  assert.strictEqual(m.balanceDue('1150.00', '400.00'), 750);
  assert.strictEqual(m.isSettled('1150.00', '400.00'), false);
  assert.strictEqual(m.isSettled('1150.00', 1150), true);
  assert.strictEqual(m.isSettled('1150.00', 400 + 750), true);
  assert.strictEqual(m.balanceDue(100, 120), 0);
});
