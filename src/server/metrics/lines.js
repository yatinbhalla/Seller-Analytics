import { getSetting } from '../db/db.js';

/**
 * Every order line with everything known about it: catalog, cost in force on its
 * date, settlement, return, and whether it carries its packet's ₹7.
 *
 * This is the one query the dashboard's numbers come from. economics.js turns each
 * line into payout, profit and return cost; aggregate.js rolls lines up.
 *
 * A line exists for every order item seen in ANY file — an invoice, a payment line or
 * a return. Payment and returns files reach back weeks before the first invoice PDF
 * was uploaded; leaving those orders out would hide most of the history. A line with
 * no invoice takes its SKU, date and price from the payment file (or the return), is
 * flagged invoice_missing, and has its GST estimated. It never moves stock: stock
 * only follows invoices, which are what was actually dispatched after the opening
 * count.
 *
 * A line from an orders report (source 'order_report') is an order line like an
 * invoice's: it moves stock and carries its packet's ₹7. It has no GST split, so it
 * is also flagged invoice_missing and estimated; line_source says 'order'. Flipkart's
 * report has no price (stored as 0), so its price comes from the payment file.
 *
 * Shopsy: a line is Shopsy's when its settlement or return says so, even if the
 * invoice did not.
 */
const FAM = (t) => `CASE WHEN ${t}.platform = 'meesho' THEN 'meesho' ELSE 'flipkart' END`;

const LINES_SQL = `
WITH st AS (
  SELECT ${FAM('s')} AS fam, COALESCE(lk.to_key, s.order_item_key) AS order_item_key, MAX(lk.via) AS linked_via,
         MAX(s.shipping_zone) AS shipping_zone,
         COUNT(*) AS n_lines,
         MAX(CASE WHEN s.txn_type IN ('return', 'rto') THEN 1 ELSE 0 END) AS has_return_txn,
         MAX(CASE WHEN s.txn_type = 'rto' THEN 1 ELSE 0 END) AS has_rto_txn,
         MAX(CASE WHEN s.platform = 'shopsy' THEN 1 ELSE 0 END) AS shopsy,
         SUM(s.net_paise) AS net, SUM(s.sale_paise) AS sale, SUM(s.refund_paise) AS refund,
         SUM(s.commission_paise) AS commission, SUM(s.fixed_fee_paise) AS fixed_fee,
         SUM(s.shipping_paise) AS shipping, SUM(s.reverse_ship_paise) AS reverse_ship,
         SUM(s.collection_paise) AS collection, SUM(s.tax_withheld_paise) AS tax_withheld,
         SUM(s.penalty_paise) AS penalty, SUM(s.claim_paise) AS claim, SUM(s.other_paise) AS other,
         MAX(s.payment_date) AS last_payment_date, MIN(s.payment_date) AS first_payment_date,
         MAX(s.order_id) AS order_id, MAX(s.sku) AS sku, MAX(s.code) AS code,
         SUM(CASE WHEN s.txn_type IN ('sale', 'return', 'rto', 'cancelled') THEN s.sale_paise END) AS sale_gross,
         MIN(s.order_date) AS order_date, MIN(s.dispatch_date) AS dispatch_date, MAX(s.qty) AS qty,
         MAX(s.gst_pct) AS gst_pct, MAX(s.invoice_no) AS invoice_no, MIN(s.invoice_date) AS invoice_date
    FROM settlement_lines s
    LEFT JOIN v_order_links lk ON lk.fam = ${FAM('s')} AND lk.from_key = s.order_item_key
   WHERE s.order_item_key IS NOT NULL
   GROUP BY fam, COALESCE(lk.to_key, s.order_item_key)
),
-- A payment or return that matched its label by invoice number, AWB or order ID
-- (v_order_links) joins that label's line: one sale stays one line.
r1 AS (
  SELECT r.*, ${FAM('r')} AS fam, COALESCE(lk.to_key, r.order_item_key) AS link_key, lk.via AS linked_via,
         ROW_NUMBER() OVER (PARTITION BY ${FAM('r')}, COALESCE(lk.to_key, r.order_item_key)
                            ORDER BY COALESCE(r.created_date, r.closed_date) DESC, r.id DESC) AS rn
    FROM returns r
    LEFT JOIN v_order_links lk ON lk.fam = ${FAM('r')} AND lk.from_key = r.order_item_key
   WHERE r.order_item_key IS NOT NULL
),
ship AS (
  SELECT ${FAM('o')} AS fam, o.shipment_key, MIN(o.id) AS first_id
    FROM orders o WHERE o.cancelled = 0 GROUP BY fam, o.shipment_key
),
k AS (
  SELECT ${FAM('o')} AS fam, o.order_item_key FROM orders o WHERE o.cancelled = 0
  UNION SELECT fam, order_item_key FROM st
  UNION SELECT fam, link_key FROM r1 WHERE rn = 1
),
base AS (
  SELECT o.id,
         k.fam || '|main|' || k.order_item_key AS natural_key,
         k.order_item_key,
         CASE WHEN o.id IS NULL OR o.source = 'order_report' THEN 1 ELSE 0 END AS invoice_missing,
         CASE WHEN o.source = 'order_report' THEN 'order' WHEN o.id IS NOT NULL THEN 'invoice'
              WHEN st.n_lines IS NOT NULL THEN 'payment' ELSE 'return' END AS line_source,
         COALESCE(o.order_id, st.order_id, r1.order_id) AS order_id,
         o.shipment_key, COALESCE(o.invoice_no, st.invoice_no, r1.invoice_no) AS invoice_no,
         COALESCE(o.invoice_date, o.order_date, st.dispatch_date, st.order_date, st.invoice_date,
                  r1.dispatch_date, r1.invoice_date, r1.created_date, st.first_payment_date) AS sale_date,
         COALESCE(o.order_date, st.order_date) AS order_date,
         CASE WHEN st.shopsy = 1 OR r1.platform = 'shopsy' THEN 'shopsy'
              ELSE COALESCE(o.platform, k.fam) END AS platform,
         COALESCE(o.sku, st.sku, r1.sku) AS sku,
         COALESCE(o.code, st.code, r1.code) AS raw_code,
         COALESCE(o.qty, st.qty, r1.qty, 1) AS qty,
         o.gross_paise, o.discount_paise, o.taxable_paise, o.tax_paise,
         COALESCE(CASE WHEN o.source = 'order_report' THEN NULLIF(o.total_paise, 0) ELSE o.total_paise END,
                  NULLIF(st.sale_gross, 0), r1.price_paise) AS known_total_paise,
         -- Money on an order whose sale was paid before this history began: a later
         -- recovery or claim, or the refund and return charges of a sale paid earlier.
         CASE WHEN o.id IS NULL AND st.n_lines IS NOT NULL AND COALESCE(st.sale_gross, 0) = 0 THEN 1 ELSE 0 END AS adjustment_only,
         st.gst_pct,
         o.ship_state, o.ship_pincode, o.import_id, o.source_ref,
         -- Buyer details from the label (local only), and the IDs each file gave, so
         -- alerts can spot files that disagree.
         o.buyer_key, o.buyer_name, o.ship_address, o.ship_city, o.payment_mode, o.awb, st.shipping_zone,
         o.invoice_no AS label_invoice_no, st.invoice_no AS settled_invoice_no, st.sale_gross AS settled_sale_gross,
         r1.invoice_no AS return_invoice_no, r1.tracking_id AS return_tracking_id,
         COALESCE(st.linked_via, r1.linked_via) AS linked_via,
         CASE WHEN o.id IS NULL OR ship.first_id = o.id THEN 1 ELSE 0 END AS first_in_shipment,
         st.n_lines AS settlement_lines, st.has_return_txn, st.net AS settled_net, st.sale AS settled_sale,
         st.refund, st.commission, st.fixed_fee, st.shipping, st.reverse_ship, st.collection,
         st.tax_withheld, st.penalty, st.claim, st.other, st.last_payment_date,
         -- A payment line that reverses the sale is a return even when its returns-file
         -- row was never uploaded; it was settled, so it is treated as closed and back.
         r1.return_key,
         COALESCE(r1.return_type, CASE WHEN st.has_return_txn = 1 THEN CASE WHEN st.has_rto_txn = 1 THEN 'rto' ELSE 'customer' END END) AS return_type,
         COALESCE(r1.status, CASE WHEN st.has_return_txn = 1 THEN 'closed' END) AS return_status,
         COALESCE(r1.outcome, CASE WHEN st.has_return_txn = 1 THEN 'received' END) AS return_outcome,
         r1.condition AS return_condition, r1.reason AS return_reason, r1.sub_reason AS return_sub_reason,
         r1.comments AS return_comments, r1.created_date AS return_created, r1.closed_date AS return_closed
    FROM k
    LEFT JOIN orders o ON ${FAM('o')} = k.fam AND o.order_item_key = k.order_item_key AND o.cancelled = 0
    LEFT JOIN st ON st.fam = k.fam AND st.order_item_key = k.order_item_key
    LEFT JOIN r1 ON r1.rn = 1 AND r1.fam = k.fam AND r1.link_key = k.order_item_key
    LEFT JOIN ship ON ship.fam = k.fam AND ship.shipment_key = o.shipment_key
)
SELECT b.*,
       rc.code AS code,
       cat.product_id, cat.product_name, cat.product_slug, cat.variant_id, cat.variant_label, cat.pack_of,
       cat.category_id, cat.category_name, cat.mrp_paise,
       CASE WHEN b.platform = 'meesho' THEN cat.meesho_price_paise ELSE cat.flipkart_price_paise END AS list_price_paise,
       (SELECT c.cost_paise FROM costs c
         WHERE c.code = rc.code AND c.effective_from <= COALESCE(b.sale_date, '9999-12-31')
         ORDER BY c.effective_from DESC LIMIT 1) AS unit_cost_paise
  FROM base b
  LEFT JOIN v_code_resolved rc ON rc.raw = b.raw_code
  LEFT JOIN v_catalog cat ON cat.code = rc.code
 WHERE (@from IS NULL OR b.sale_date >= @from)
   AND (@to IS NULL OR b.sale_date <= @to)
 ORDER BY b.sale_date, b.natural_key`;

/**
 * Load lines and fill in what a line without an invoice lacks:
 *   - price: the payment file's sale amount, else the return's price, else the list
 *     price for that platform (flagged price_estimated)
 *   - GST: from the payment file's GST %, else the rate this code's invoices carry,
 *     else the default rate in Settings (flagged gst_estimated)
 */
export function loadLines(db, { from = null, to = null } = {}) {
  const lines = db.prepare(LINES_SQL).all({ from, to });
  const defaultGst = Number(getSetting(db, 'default_gst_pct'));
  const rateByCode = invoiceGstRates(db);
  for (const l of lines) {
    l.price_estimated = 0;
    l.gst_estimated = 0;
    if (l.adjustment_only) {
      l.total_paise = 0;
    } else if (l.known_total_paise == null) {
      l.total_paise = l.list_price_paise != null ? l.list_price_paise * l.qty : 0;
      l.price_estimated = 1;
    } else {
      l.total_paise = l.known_total_paise;
    }
    if (l.invoice_missing) {
      const rate = l.gst_pct ?? rateByCode.get(l.code) ?? defaultGst;
      l.tax_paise = Math.round((l.total_paise * rate) / (100 + rate));
      l.taxable_paise = l.total_paise - l.tax_paise;
      l.gross_paise = l.total_paise;
      l.discount_paise = 0;
      l.gst_estimated = 1;
    }
  }
  return lines;
}

/** GST rate each code's own invoices carry (tax ÷ taxable value), rounded to a slab. */
function invoiceGstRates(db) {
  const rows = db
    .prepare(`SELECT COALESCE(rc.code, o.code) AS code, SUM(o.tax_paise) AS tax, SUM(o.taxable_paise) AS taxable
                FROM orders o LEFT JOIN v_code_resolved rc ON rc.raw = o.code
               WHERE o.taxable_paise > 0 GROUP BY 1`)
    .all();
  const slabs = [0, 3, 5, 12, 18, 28];
  return new Map(
    rows.map((r) => {
      const pct = (r.tax / r.taxable) * 100;
      return [r.code, slabs.reduce((best, s) => (Math.abs(s - pct) < Math.abs(best - pct) ? s : best), 5)];
    }),
  );
}

/** Filters applied after loading, so platform is the effective one (Shopsy detected late). */
export function filterLines(lines, { platforms, categoryId, productId, code } = {}) {
  return lines.filter(
    (l) =>
      (!platforms?.length || platforms.includes(l.platform)) &&
      (!categoryId || l.category_id === Number(categoryId)) &&
      (!productId || l.product_id === Number(productId)) &&
      (!code || l.code === code || l.raw_code === code),
  );
}

export function economicsContext(db) {
  return {
    packagingPaise: Number(getSetting(db, 'packaging_paise')),
    defaultCondition: getSetting(db, 'default_return_condition'),
    windowDays: Number(getSetting(db, 'estimate_window_days')),
    gstMode: getSetting(db, 'gst_mode') || 'ignore',
  };
}

/** Ads and other money lines that belong to no order. */
export function loadUnlinkedCosts(db, { from = null, to = null } = {}) {
  return db
    .prepare(`SELECT platform, txn_type, SUM(net_paise) AS net, SUM(ads_paise) AS ads, COUNT(*) AS n
                FROM settlement_lines
               WHERE order_item_key IS NULL
                 AND (@from IS NULL OR payment_date >= @from) AND (@to IS NULL OR payment_date <= @to)
               GROUP BY platform, txn_type`)
    .all({ from, to });
}
