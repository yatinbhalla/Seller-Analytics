const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-IN');

/** Paise → "₹1,23,456" (Indian grouping). `exact` keeps the paise. */
export function rs(paise, { exact = false } = {}) {
  if (paise == null || Number.isNaN(paise)) return '—';
  return (exact ? inr2 : inr0).format(paise / 100);
}

/** Paise → "₹1.2L" / "₹3.4Cr" for axes and tight spots. */
export function rsShort(paise) {
  if (paise == null) return '—';
  const r = paise / 100;
  const a = Math.abs(r);
  if (a >= 1e7) return `₹${(r / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `₹${(r / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `₹${(r / 1e3).toFixed(1)}k`;
  return `₹${Math.round(r)}`;
}

export function n(v) {
  return v == null ? '—' : int.format(v);
}

export function pct(v, digits = 1) {
  return v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(digits)}%`;
}

export const PLATFORMS = [
  { key: 'flipkart', label: 'Flipkart', color: 'var(--fk)' },
  { key: 'shopsy', label: 'Shopsy', color: 'var(--sh)' },
  { key: 'meesho', label: 'Meesho', color: 'var(--ms)' },
];
export const platformLabel = (k) => PLATFORMS.find((p) => p.key === k)?.label || k;
export const platformColor = (k) => PLATFORMS.find((p) => p.key === k)?.color || 'var(--muted)';

export function today() {
  // The PC's own date, not UTC (which is still yesterday in India until 5:30 am).
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function shiftDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function niceDate(ymd) {
  if (!ymd) return '—';
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });
}
