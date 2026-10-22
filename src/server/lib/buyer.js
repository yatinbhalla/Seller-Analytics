/**
 * Who a buyer is, from what a label prints.
 *
 * The same name at the same PIN code is the same buyer, on any platform. Names are
 * compared without case, titles or punctuation, so "Mr. Ramesh  Kumar" and
 * "RAMESH KUMAR" at one PIN code are one person. Two people of one name in one PIN
 * code would merge; a person who moves gets a second key. Both are rare enough to
 * accept for a seller's return-pattern view.
 *
 * Names and addresses stay in the local database. They are never sent to Gemini.
 */
const TITLES = /^(mr|mrs|ms|miss|smt|shri|sri|dr|mx)\s+/;

export function normName(name) {
  if (!name) return null;
  let s = String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  while (TITLES.test(s)) s = s.replace(TITLES, '');
  return s || null;
}

export function buyerKey(name, pincode) {
  const n = normName(name);
  return n && pincode ? `${n}|${pincode}` : null;
}

/**
 * "cod" or "prepaid" from a label's or report's payment wording. Meesho labels say
 * "Prepaid: Do not collect cash", "COD: Check the payable amount on the app", or just
 * "Check the payable amount on the app" — the courier collects in both of the latter.
 */
export function paymentMode(text) {
  if (!text) return null;
  if (/prepaid/i.test(text)) return 'prepaid';
  if (/\bcod\b|cash\s*on\s*delivery|postpaid|payable\s*amount/i.test(text)) return 'cod';
  return null;
}
