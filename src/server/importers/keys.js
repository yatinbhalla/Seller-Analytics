import crypto from 'crypto';

/**
 * Natural keys and content hashes — what makes daily, overlapping uploads safe.
 *
 * A row is identified by what it IS (this order line, this return, this payment
 * line), never by which file it came from. The same order in Monday's and Tuesday's
 * invoice download is one key, so it lands once.
 *
 * Flipkart and Shopsy share one key space. Shopsy orders arrive through Flipkart
 * Seller Hub and a file does not always say which storefront a line came from; if the
 * two were keyed apart, the same order seen once as "flipkart" and once as "shopsy"
 * would be counted twice.
 */
export function family(platform) {
  return platform === 'meesho' ? 'meesho' : 'flipkart';
}

export function naturalKey(platform, account, key) {
  return `${family(platform)}|${account || 'main'}|${key}`;
}

/**
 * The one way an order line is identified on each platform, used by invoices,
 * payments and returns alike so they join.
 *
 * Meesho prints the sub-order number (123456789012345678_1) on every document.
 * Flipkart's invoice carries the order ID but not the order-item ID, so a Flipkart
 * line is order ID + SKU — which the settlement and returns reports also carry.
 */
export function orderItemKey(platform, { orderId, subOrderNo, sku }) {
  if (family(platform) === 'meesho') return String(subOrderNo || '').trim();
  return `${String(orderId || '').trim()}:${String(sku || '').trim().replace(/\s+/g, '').toUpperCase()}`;
}

/** Fields that describe a row's content. Bookkeeping fields never change its hash. */
const NOT_CONTENT = new Set(['import_id', 'source_ref', 'content_hash', 'updated_at', 'id', 'rowNo', 'natural_key']);

export function contentHash(payload) {
  const clean = {};
  for (const k of Object.keys(payload).sort()) {
    if (NOT_CONTENT.has(k)) continue;
    const v = payload[k];
    clean[k] = v === undefined ? null : v;
  }
  return crypto.createHash('sha256').update(JSON.stringify(clean)).digest('hex');
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Money columns per entity: a change in any of these needs the seller's confirmation. */
export const MONEY_FIELDS = {
  order: ['qty', 'gross_paise', 'discount_paise', 'taxable_paise', 'tax_paise', 'total_paise'],
  return: [],
  settlement: [
    'sale_paise', 'refund_paise', 'commission_paise', 'fixed_fee_paise', 'shipping_paise', 'reverse_ship_paise',
    'collection_paise', 'tax_withheld_paise', 'penalty_paise', 'claim_paise', 'ads_paise', 'other_paise', 'net_paise',
  ],
};

/** The figure a file's rows are totalled by for reconciliation. */
export function moneyOf(entity, payload) {
  if (entity === 'order') return payload.total_paise ?? 0;
  if (entity === 'settlement') return payload.net_paise ?? 0;
  return 0;
}
