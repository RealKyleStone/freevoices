/**
 * Mirrors src/services/document-math.js so the editor previews exactly the
 * figures and dates the server will store. Change one, change both.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Round to cents, half away from zero, on the decimal value rather than the float. */
export function roundCents(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const cents = Number((Math.abs(n) * 100).toPrecision(12));
  return (Math.sign(n) * Math.round(cents)) / 100;
}

export interface LineTotals { subtotal: number; vat: number; total: number; }

export function lineTotals(item: { quantity?: unknown; unit_price?: unknown; vat_rate?: unknown; vat_inclusive?: unknown }): LineTotals {
  const inclusive = [true, 1, '1', 'true'].some(value => value === item.vat_inclusive);
  const enteredAmount = roundCents((Number(item.quantity) || 0) * (Number(item.unit_price) || 0));
  const rawRate = Number(item.vat_rate);
  const rate = Number.isFinite(rawRate) ? rawRate : 15;
  const subtotal = inclusive ? roundCents(enteredAmount / (1 + rate / 100)) : enteredAmount;
  const vat = inclusive ? roundCents(enteredAmount - subtotal) : roundCents(subtotal * rate / 100);
  return { subtotal, vat, total: inclusive ? enteredAmount : roundCents(subtotal + vat) };
}

/**
 * Today on the user's own calendar, as 'YYYY-MM-DD'.
 * `new Date().toISOString()` is the UTC day, which in South Africa is
 * yesterday until 02:00.
 */
export function todayLocalIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Issue date + payment terms, or '' when either is missing. */
export function dueDateFromTerms(issueDate: string, paymentTerms: unknown): string {
  if (!issueDate || !DATE_ONLY.test(issueDate)) return '';
  if (paymentTerms === '' || paymentTerms === null || paymentTerms === undefined) return '';
  const terms = parseInt(String(paymentTerms), 10);
  if (!Number.isFinite(terms) || terms < 0) return '';
  return addDaysIso(issueDate, terms);
}

/**
 * A stored calendar date as a local Date at midnight. `new Date('2026-10-20')`
 * is UTC midnight, which is the 19th for anyone west of Greenwich.
 */
export function parseDateOnly(value: string): Date {
  const iso = String(value).slice(0, 10);
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
