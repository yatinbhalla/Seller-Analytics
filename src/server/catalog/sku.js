/**
 * Marketplace SKU → SKU code.
 *
 * Every listing SKU is CODE/number (WH_MFO/40365, TC_BT/1.1, TC_BT/7). The number
 * only tells listing copies apart; it never changes the product, the pack or the
 * cost, so everything downstream keys on the code. A SKU without a '/' is all code.
 *
 * Codes are compared trimmed and upper-cased — TC_NW_Frill and TC_NW_FRILL are the
 * same code — but the SKU itself is stored as written.
 */
export function normCode(code) {
  return String(code ?? '').trim().replace(/\s+/g, '').toUpperCase();
}

export function parseSku(raw) {
  const sku = String(raw ?? '').trim();
  if (!sku) return null;
  const slash = sku.lastIndexOf('/');
  const code = slash > 0 ? sku.slice(0, slash) : sku;
  return {
    sku,
    code: normCode(code),
    listingNo: slash > 0 ? sku.slice(slash + 1).trim() || null : null,
  };
}

/** A code from the listers' patterns: "TC_BT/{X}" → "TC_BT". */
export function codeFromPattern(pattern) {
  if (!pattern) return null;
  return normCode(String(pattern).replace(/\/?\{X\}.*$/, ''));
}

/**
 * Resolve a raw code to its canonical code, or null if the catalog has never seen it.
 * One prepared statement per database, reused across calls.
 */
const stmts = new WeakMap();
export function resolveCode(db, rawCode) {
  let s = stmts.get(db);
  if (!s) {
    s = db.prepare('SELECT code FROM v_code_resolved WHERE raw = ?');
    stmts.set(db, s);
  }
  const hit = s.get(normCode(rawCode));
  return hit ? hit.code : null;
}
