/**
 * The three things an import can write, and how to read and write each by natural key.
 * Column lists are the single source of truth for staging, commit and undo.
 */
export const ENTITIES = {
  order: {
    table: 'orders',
    columns: [
      'platform', 'account', 'order_item_key', 'order_id', 'shipment_key', 'invoice_no', 'invoice_date', 'order_date',
      'sku', 'code', 'qty', 'gross_paise', 'discount_paise', 'taxable_paise', 'tax_paise', 'total_paise',
      'ship_state', 'ship_pincode', 'cancelled',
      // From the label (or the cancellations file); local database only.
      'buyer_name', 'buyer_key', 'ship_address', 'ship_city', 'payment_mode', 'awb',
      // 'order_report' when the line is known only from an orders report.
      'source',
    ],
  },
  return: {
    table: 'returns',
    columns: [
      'platform', 'account', 'return_key', 'order_item_key', 'order_id', 'sku', 'code', 'qty', 'return_type', 'reason',
      'sub_reason', 'comments', 'created_date', 'closed_date', 'status', 'outcome', 'condition', 'condition_set_by',
      'raw_status', 'dispatch_date', 'price_paise', 'invoice_no', 'invoice_date', 'tracking_id',
    ],
  },
  settlement: {
    table: 'settlement_lines',
    columns: [
      'platform', 'account', 'order_item_key', 'order_id', 'sku', 'code', 'txn_type', 'payment_date', 'settlement_ref',
      'sale_paise', 'refund_paise', 'commission_paise', 'fixed_fee_paise', 'shipping_paise', 'reverse_ship_paise',
      'collection_paise', 'tax_withheld_paise', 'tcs_paise', 'tds_paise', 'penalty_paise', 'claim_paise', 'ads_paise', 'other_paise', 'net_paise',
      'order_date', 'dispatch_date', 'qty', 'gst_pct', 'invoice_no', 'invoice_date', 'breakdown_json', 'shipping_zone',
    ],
  },
};

/** Only the declared columns, with missing ones as null — a payload can never smuggle in a column. */
export function pick(entity, payload) {
  const out = {};
  for (const c of ENTITIES[entity].columns) out[c] = payload[c] === undefined ? null : payload[c];
  return out;
}

const cache = new WeakMap();
function stmts(db) {
  let s = cache.get(db);
  if (s) return s;
  s = {};
  for (const [name, { table, columns }] of Object.entries(ENTITIES)) {
    const all = ['natural_key', ...columns, 'import_id', 'source_ref', 'content_hash'];
    s[name] = {
      get: db.prepare(`SELECT * FROM ${table} WHERE natural_key = ?`),
      insert: db.prepare(`INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map((c) => '@' + c).join(', ')})`),
      update: db.prepare(
        `UPDATE ${table} SET ${[...columns, 'import_id', 'source_ref', 'content_hash'].map((c) => `${c} = @${c}`).join(', ')},
         updated_at = datetime('now') WHERE natural_key = @natural_key`,
      ),
      remove: db.prepare(`DELETE FROM ${table} WHERE natural_key = ?`),
    };
  }
  cache.set(db, s);
  return s;
}

export const getRow = (db, entity, key) => stmts(db)[entity].get.get(key);
export const insertRow = (db, entity, row) => stmts(db)[entity].insert.run(row);
export const updateRow = (db, entity, row) => stmts(db)[entity].update.run(row);
export const removeRow = (db, entity, key) => stmts(db)[entity].remove.run(key);

/**
 * Merge what a file says about an order line into what is already known.
 *
 * - A cancellation only marks the line cancelled. What the invoice said about it
 *   (price, GST, platform) stays; a gap the invoice left is filled.
 * - Cancelled is final. An invoice uploaded after the cancellation must not bring the
 *   line back into sales, stock and packaging.
 * - An orders report knows less than an invoice. Over an invoice it only fills gaps
 *   (and can cancel); an invoice over an orders-report line replaces it.
 * - Two orders-report rows of one sub-order on different order dates are a sale and
 *   its door-step exchange: Meesho ships the replacement days later under the same
 *   sub-order number, in a new packet. The earlier row is the sale and is kept.
 */
export function mergeOrder(existing, incoming) {
  if (!existing) return incoming;
  const known = pick('order', existing);
  if (isOrderReport(incoming) && !isOrderReport(known)) {
    const merged = { ...known, cancelled: known.cancelled || incoming.cancelled ? 1 : 0 };
    for (const c of ENTITIES.order.columns) if (merged[c] == null && incoming[c] != null && c !== 'source') merged[c] = incoming[c];
    return merged;
  }
  if (isExchange(known, incoming)) return incoming.order_date < known.order_date ? incoming : known;
  if (incoming.cancelled) {
    const merged = { ...known, cancelled: 1 };
    for (const c of ENTITIES.order.columns) if (merged[c] == null && incoming[c] != null) merged[c] = incoming[c];
    return merged;
  }
  return { ...incoming, cancelled: known.cancelled ? 1 : 0 };
}

export const isOrderReport = (order) => order?.source === 'order_report';

/** Both rows from orders reports, one sub-order, two order dates: a sale and its exchange. */
export const isExchange = (a, b) =>
  isOrderReport(a) && isOrderReport(b) && !!a.order_date && !!b.order_date && a.order_date !== b.order_date;

/**
 * Merge what a returns file says into what is already known about that return.
 *
 * - A field the new row leaves blank keeps its old value: the closure file often has
 *   no reason, the created file no closed date.
 * - Closed is final. Re-uploading an old return-created file after the closure must
 *   not reopen the return.
 * - A condition the seller set by hand beats one read from a file.
 * - Shopsy beats Flipkart: once any file says the order is Shopsy's, it is.
 */
export function mergeReturn(existing, incoming) {
  if (!existing) return { ...incoming, condition_set_by: incoming.condition ? 'file' : null };
  const merged = { ...pick('return', existing) };
  for (const c of ENTITIES.return.columns) {
    if (incoming[c] != null && incoming[c] !== '') merged[c] = incoming[c];
  }
  if (existing.status === 'closed' && incoming.status !== 'closed') {
    merged.status = 'closed';
    merged.outcome = existing.outcome;
    merged.closed_date = existing.closed_date;
  }
  if (existing.condition_set_by === 'seller') {
    merged.condition = existing.condition;
    merged.condition_set_by = 'seller';
  } else if (incoming.condition) {
    merged.condition_set_by = 'file';
  }
  if (existing.platform === 'shopsy' || incoming.platform === 'shopsy') merged.platform = 'shopsy';
  return merged;
}
