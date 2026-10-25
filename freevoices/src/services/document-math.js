/**
 * Money and calendar-date rules for invoices and quotes.
 *
 * Pure: no database, no Express, so it can be tested with `node --test` and
 * shared by every route that prices a document or stamps a date on one. The
 * create, update and convert paths used to each carry their own copy of the
 * line-total arithmetic and their own idea of "today", which is how the due
 * date and the rounding drifted apart between them.
 *
 * The frontend mirrors roundCents/computeLine in
 * src/app/shared/utils/document-math.ts so the editor previews exactly what
 * the server will store. Change one, change both.
 */

// FreeVoices invoices South African businesses. "Today" on a document means
// today in Johannesburg, not today in UTC — between 00:00 and 02:00 SAST the
// two disagree.
const BUSINESS_TIME_ZONE = process.env.BUSINESS_TIME_ZONE || 'Africa/Johannesburg';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Round to cents, half away from zero.
 *
 * `Number.prototype.toFixed` rounds the binary value, not the decimal one, so
 * 1.5 x 99.99 = 149.985 (stored as 149.98499999...) came out as 149.98. The
 * toPrecision step snaps the float back to the decimal it was meant to be
 * before rounding.
 */
function roundCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const cents = Number((Math.abs(n) * 100).toPrecision(12));
  return (Math.sign(n) * Math.round(cents)) / 100;
}

/**
 * Price one line. Each line is rounded to cents on its own and the document
 * totals are the sum of the rounded lines, so the figures on the PDF always
 * add up as printed.
 */
function computeLine(item) {
  const quantity = Number(item.quantity) || 0;
  const unit_price = Number(item.unit_price) || 0;
  const rawRate = Number(item.vat_rate);
  const vat_rate = Number.isFinite(rawRate) ? rawRate : 15;
  const vat_inclusive = [true, 1, '1', 'true'].includes(item.vat_inclusive);
  const enteredAmount = roundCents(quantity * unit_price);
  const subtotal = vat_inclusive ? roundCents(enteredAmount / (1 + vat_rate / 100)) : enteredAmount;
  const vat_amount = vat_inclusive ? roundCents(enteredAmount - subtotal) : roundCents(subtotal * vat_rate / 100);
  const total = vat_inclusive ? enteredAmount : roundCents(subtotal + vat_amount);
  return { ...item, quantity, unit_price, vat_rate, vat_inclusive, subtotal, vat_amount, total };
}

function computeDocumentTotals(items) {
  const lines = (items || []).map(computeLine);
  const sum = (key) => roundCents(lines.reduce((s, l) => s + l[key], 0));
  return { lines, subtotal: sum('subtotal'), vat_amount: sum('vat_amount'), total: sum('total') };
}

/** Today's calendar date in the business time zone, as 'YYYY-MM-DD'. */
function todayIso(now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** 'YYYY-MM-DD' + n calendar days, computed in UTC so no DST or offset can shift it. */
function addDaysIso(isoDate, days) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

/** Payment terms as an integer number of days, or null when not given. */
function normaliseTerms(paymentTerms) {
  if (paymentTerms === '' || paymentTerms === null || paymentTerms === undefined) return null;
  const n = parseInt(paymentTerms, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The due date a document should carry: the one the user gave, otherwise the
 * issue date plus the payment terms. Null only when there is neither.
 *
 * Every creation path — manual, quote conversion, recurring — goes through
 * this, so "30-day terms" means the same thing however the invoice was made.
 */
function resolveDueDate(issueDate, dueDate, paymentTerms) {
  if (dueDate && DATE_ONLY.test(String(dueDate))) return String(dueDate);
  const terms = normaliseTerms(paymentTerms);
  if (terms === null || !issueDate) return null;
  return addDaysIso(issueDate, terms);
}

/**
 * Format a stored calendar date for people. A 'YYYY-MM-DD' string is rendered
 * as that day in UTC, so the server's own time zone can never move it.
 */
function formatDisplayDate(value, options = { day: '2-digit', month: 'short', year: 'numeric' }) {
  if (!value) return '—';
  if (DATE_ONLY.test(String(value))) {
    return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-ZA', { ...options, timeZone: 'UTC' });
  }
  return new Date(value).toLocaleDateString('en-ZA', { ...options, timeZone: BUSINESS_TIME_ZONE });
}

// Within half a cent counts as settled; amounts are stored to two decimals.
const SETTLED_TOLERANCE = 0.005;

/** Outstanding balance, never negative. */
function balanceDue(total, amountPaid) {
  return Math.max(0, roundCents(Number(total) - Number(amountPaid || 0)));
}

function isSettled(total, amountPaid) {
  return Number(amountPaid || 0) >= Number(total) - SETTLED_TOLERANCE;
}

module.exports = {
  BUSINESS_TIME_ZONE,
  roundCents,
  computeLine,
  computeDocumentTotals,
  todayIso,
  addDaysIso,
  normaliseTerms,
  resolveDueDate,
  formatDisplayDate,
  balanceDue,
  isSettled,
  SETTLED_TOLERANCE,
};
