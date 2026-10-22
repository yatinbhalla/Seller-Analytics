/**
 * Read a return's lifecycle from the status text a marketplace prints.
 *
 * The return-created and return-closure files are the same kind of report at two
 * moments, so ONE importer reads both: each row says what it knows, and rows with the
 * same return key merge (see stage.js). Closure is recognised from the status or from
 * a closed/received date being present.
 */
const CLOSED_RECEIVED = /complet|deliver|receiv|returned to seller|return(ed)? to origin|rto delivered|closed/i;
const CLOSED_LOST = /lost|missing/i;
const CLOSED_CLAIM = /claim/i;
const CANCELLED = /cancel|rejected/i;

export function lifecycle(rawStatus, closedDate) {
  const s = String(rawStatus || '');
  if (CANCELLED.test(s)) return { status: 'closed', outcome: 'cancelled' };
  if (CLOSED_LOST.test(s)) return { status: 'closed', outcome: 'lost' };
  if (CLOSED_CLAIM.test(s)) return { status: 'closed', outcome: 'claimed' };
  if (CLOSED_RECEIVED.test(s) && !/out for|in transit|expected/i.test(s)) return { status: 'closed', outcome: 'received' };
  if (closedDate) return { status: 'closed', outcome: 'received' };
  return { status: 'open', outcome: null };
}

/** Courier returns (RTO: the buyer never took the parcel) against customer returns. */
export function returnType(raw) {
  return /rto|courier|undeliver|origin/i.test(String(raw || '')) ? 'rto' : 'customer';
}

/**
 * Flipkart prints reasons as codes — QUALITY_ISSUE, SIZE_FIT_ISSUES,
 * ORC_validated with customer. Make them read like the Meesho ones: "Quality issue",
 * "Size fit issues", "ORC validated with customer".
 */
export function humanReason(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s.includes('_') && s !== s.toUpperCase()) return s;
  const words = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const lower = words === words.toUpperCase() ? words.toLowerCase() : words;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** A condition only when the file states one; null leaves it to the seller's default. */
export function conditionOf(raw) {
  const s = String(raw || '');
  if (!s) return null;
  if (/damag|defect|used|wrong|bad|unsellable/i.test(s)) return 'damaged';
  if (/missing|empty|lost/i.test(s)) return 'missing';
  if (/good|ok|sellable|approved|intact/i.test(s)) return 'good';
  return null;
}
