import { CellError, date, paise } from '../lib/parse.js';

/**
 * Helpers for reading label-and-invoice PDFs, shared by the Flipkart and Meesho parsers.
 *
 * The PDFs are not tables, so nothing here is trusted on its own: every invoice the
 * parsers build is checked by validateInvoice() and quarantined if any check fails.
 */

/** CODE/number tokens: WH_MFO/40365, TC_60*90_BT/1.1, tc_bt/7. */
const SKU_RE = /(?<![A-Za-z0-9_*])([A-Za-z][A-Za-z0-9_*]*\/\d+(?:\.\d+)?)(?![A-Za-z0-9])/g;

export function findSkus(line) {
  return [...line.matchAll(SKU_RE)].map((m) => m[1]);
}

/** Amounts with exactly two decimals, optionally prefixed Rs./₹ — never "@12.0%" or "18.0 %". */
const AMOUNT_RE = /(?:Rs\.?\s*|₹\s*|INR\s*)?(-?\d[\d,]*\.\d{2})(?![\d%]|\s*%)/g;

export function amounts(line) {
  return [...line.matchAll(AMOUNT_RE)].map((m) => ({ paise: paise(m[1]), index: m.index }));
}

/**
 * One invoice line item: "… 1 379.00 -0.00 321.19 57.81 379.00" (Flipkart) or
 * "… 6302 1 Rs.190.00 Rs.0.00 Rs.169.64 IGST @12.0% Rs.20.36 Rs.190.00" (Meesho).
 *
 * Read as qty, gross, discount, taxable, tax…, total — tax being one figure (IGST)
 * or two (CGST + SGST). Returns null for lines that are not item rows.
 */
export function itemFromLine(line) {
  const nums = amounts(line);
  if (nums.length < 4) return null;
  const before = line.slice(0, nums[0].index).trim().split(/\s+/);
  const qtyToken = before[before.length - 1];
  if (!/^\d{1,3}$/.test(qtyToken || '')) return null;
  const values = nums.map((n) => n.paise);
  const total = values[values.length - 1];
  const taxable = values[2];
  const tax = values.slice(3, -1).reduce((a, b) => a + b, 0);
  return {
    qty: Number(qtyToken),
    gross: values[0],
    discount: Math.abs(values[1]),
    taxable,
    tax: values.length > 4 ? tax : total - taxable,
    total,
    label: before.slice(0, -1).join(' '),
  };
}

export function firstMatch(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

export function dateFrom(text, re) {
  const raw = firstMatch(text, re);
  if (!raw) return null;
  try {
    return date(raw);
  } catch {
    return null;
  }
}

const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

/** Flipkart labels print the state as an ISO code: "Lucknow - 226017 , IN-UP". */
const STATE_CODES = {
  AN: 'Andaman and Nicobar Islands', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar',
  CH: 'Chandigarh', CT: 'Chhattisgarh', CG: 'Chhattisgarh', DH: 'Dadra and Nagar Haveli and Daman and Diu',
  DN: 'Dadra and Nagar Haveli and Daman and Diu', DD: 'Dadra and Nagar Haveli and Daman and Diu', DL: 'Delhi', GA: 'Goa',
  GJ: 'Gujarat', HR: 'Haryana', HP: 'Himachal Pradesh', JK: 'Jammu and Kashmir', JH: 'Jharkhand', KA: 'Karnataka',
  KL: 'Kerala', LA: 'Ladakh', LD: 'Lakshadweep', MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur', ML: 'Meghalaya',
  MZ: 'Mizoram', NL: 'Nagaland', OR: 'Odisha', OD: 'Odisha', PY: 'Puducherry', PB: 'Punjab', RJ: 'Rajasthan', SK: 'Sikkim',
  TN: 'Tamil Nadu', TG: 'Telangana', TS: 'Telangana', TR: 'Tripura', UP: 'Uttar Pradesh', UT: 'Uttarakhand', UK: 'Uttarakhand',
  WB: 'West Bengal',
};

/**
 * Ship-to state and pincode, and nothing else from the address.
 *
 * The buyer's name, street and phone are never extracted, so they cannot be stored.
 * The block searched starts at the ship-to heading and stops at the seller's own
 * details, so the seller's pincode is not taken for the buyer's.
 */
export function shipTo(lines, headingRe, stopRe) {
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start === -1) return { state: null, pincode: null };
  const block = [];
  for (let i = start; i < Math.min(lines.length, start + 10); i++) {
    if (i > start && stopRe && stopRe.test(lines[i])) break;
    block.push(lines[i]);
  }
  const text = block.join(' ');
  const pin = text.match(/(?<!\d)([1-9]\d{5})(?!\d)/);
  const code = text.match(/\bIN-([A-Z]{2})\b/);
  const state =
    (code && STATE_CODES[code[1]]) ||
    STATES.find((s) => new RegExp(`\\b${s.replace(/ /g, '\\s+')}\\b`, 'i').test(text)) ||
    null;
  return { state, pincode: pin ? pin[1] : null };
}

/**
 * Throws a CellError describing the first check an invoice fails. The tolerance is
 * ₹1: marketplaces round each tax line separately, so the parts can differ from the
 * total by a few paise, never by a rupee.
 */
export function validateInvoice(inv, { orderIdRe }) {
  if (!inv.orderId || !orderIdRe.test(inv.orderId)) throw new CellError(`no valid order ID found (got "${inv.orderId || ''}")`);
  if (!inv.skus.length) throw new CellError('no SKU found on the page');
  if (!inv.items.length) throw new CellError('no invoice line items found');
  if (inv.items.length !== inv.skus.length) {
    throw new CellError(`${inv.skus.length} SKU(s) but ${inv.items.length} invoice line(s) — cannot pair them safely`);
  }
  for (const it of inv.items) {
    if (!(it.qty >= 1)) throw new CellError('quantity below 1');
    if (Math.abs(it.taxable + it.tax - it.total) > 100) {
      throw new CellError(`line does not add up: taxable ${it.taxable / 100} + tax ${it.tax / 100} ≠ total ${it.total / 100}`);
    }
    // Meesho prints the tax on the line below the item, so for those lines the tax is
    // inferred from the total; gross − discount = total is then the independent check.
    if (Math.abs(it.gross - it.discount - it.total) > 100) {
      throw new CellError(`line does not add up: gross ${it.gross / 100} − discount ${it.discount / 100} ≠ total ${it.total / 100}`);
    }
  }
  if (inv.grandTotal != null) {
    const sum = inv.items.reduce((a, it) => a + it.total, 0) + (inv.shippingCharge || 0);
    if (Math.abs(sum - inv.grandTotal) > 100) {
      throw new CellError(`lines total ${sum / 100} but the invoice says ${inv.grandTotal / 100}`);
    }
  }
}
