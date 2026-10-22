/**
 * Cell parsers shared by every importer.
 *
 * Each one returns null for a blank cell and THROWS for a cell it cannot read. A
 * thrown error rejects that row into quarantine; it never turns into a zero or a
 * guessed date, because a silently wrong number is worse than a missing one.
 */

export class CellError extends Error {}

const BLANK = new Set(['', '-', 'na', 'n/a', 'null', 'nil', 'none']);

export function isBlank(v) {
  return v == null || BLANK.has(String(v).trim().toLowerCase());
}

/**
 * Money → integer paise.
 *
 * Handles "₹1,234.50", "Rs. 1234.5", "INR 12", "(12.00)" and "-12" as negatives, and
 * plain numbers. Anything with more than two decimals is rounded half away from zero
 * to the paisa, which is how the marketplaces themselves round.
 */
export function paise(v) {
  if (isBlank(v)) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new CellError(`not a number: ${v}`);
    return roundPaise(v);
  }
  let s = String(v).trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/₹|rs\.?|inr/gi, '').replace(/[,\s]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new CellError(`not an amount: "${v}"`);
  const p = roundPaise(Number(s));
  return negative ? -p : p;
}

function roundPaise(rupees) {
  const sign = rupees < 0 ? -1 : 1;
  // toFixed on the scaled value avoids 1.005 * 100 = 100.49999…
  return sign * Math.round(Number((Math.abs(rupees) * 100).toFixed(4)));
}

export function int(v) {
  if (isBlank(v)) return null;
  const s = String(v).trim().replace(/,/g, '');
  if (!/^-?\d+(\.0+)?$/.test(s)) throw new CellError(`not a whole number: "${v}"`);
  return Number.parseInt(s, 10);
}

export function percent(v) {
  if (isBlank(v)) return null;
  const s = String(v).trim().replace('%', '');
  const n = Number(s);
  if (!Number.isFinite(n)) throw new CellError(`not a percentage: "${v}"`);
  return n;
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Date → 'YYYY-MM-DD'.
 *
 * Indian marketplace exports are day-first, so "05/10/2026" is 5 October — never
 * read month-first. Accepts ISO dates and timestamps, DD-MM-YYYY with -, / or .,
 * "05 Oct 2026", "Oct 05, 2026" and Excel serial numbers (days since 1899-12-30).
 */
export function date(v) {
  if (isBlank(v)) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new CellError('invalid date');
    return ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
  }
  const s = String(v).trim();

  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    // 30000 ≈ 1982, 80000 ≈ 2119: outside that, it is an ID, not a date.
    if (serial < 30000 || serial > 80000) throw new CellError(`not a date: "${v}"`);
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
    return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/);
  if (m) return ymd(fullYear(+m[3]), +m[2], +m[1]);

  m = s.match(/^(\d{1,2})[\s-]([a-z]{3,9})[\s,-]+(\d{2}|\d{4})\b/i);
  if (m && monthOf(m[2])) return ymd(fullYear(+m[3]), monthOf(m[2]), +m[1]);

  m = s.match(/^([a-z]{3,9})[\s-](\d{1,2}),?\s+(\d{4})\b/i);
  if (m && monthOf(m[1])) return ymd(+m[3], monthOf(m[1]), +m[2]);

  throw new CellError(`not a date: "${v}"`);
}

function monthOf(name) {
  const k = name.toLowerCase();
  return MONTHS[k.slice(0, 4)] || MONTHS[k.slice(0, 3)] || null;
}

function fullYear(y) {
  return y < 100 ? 2000 + y : y;
}

function ymd(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) {
    throw new CellError(`impossible date ${d}-${mo}-${y}`);
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) throw new CellError(`impossible date ${d}-${mo}-${y}`);
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * An identifier cell, kept exactly as text.
 *
 * Excel turns long numbers into "1.15993E+17" and that cannot be undone — the digits
 * are gone. Such a cell is refused rather than stored as a wrong ID that would
 * later match the wrong order.
 */
export function id(v) {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  if (/^\d(\.\d+)?e\+?\d+$/i.test(s)) {
    throw new CellError(`ID was mangled by Excel into scientific notation: "${s}"`);
  }
  return s;
}

export function text(v) {
  if (isBlank(v)) return null;
  return String(v).replace(/\s+/g, ' ').trim();
}

/** Header text → comparison key: "Sub Order No." and "sub_order_no" both → "subordernumber"-ish. */
export function headerKey(h) {
  return String(h ?? '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}
