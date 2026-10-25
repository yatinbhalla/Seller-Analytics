-- Views are dropped and recreated on every start, so they can change without a
-- migration. Tables live in schema.sql.

DROP VIEW IF EXISTS v_code_resolved;
DROP VIEW IF EXISTS v_catalog;
DROP VIEW IF EXISTS v_stock_ledger;
DROP VIEW IF EXISTS v_stock_on_hand;
DROP VIEW IF EXISTS v_order_links;

-- A payment or return line whose order-item key matches no label → the label it
-- belongs to, by the other IDs the files share: the invoice number, the courier's
-- tracking number (an RTO comes back on the label's AWB), or, on Flipkart, the order
-- ID when that order has a single line. Tried in that order; a step that would point
-- at two order lines is skipped, never guessed between.
CREATE VIEW v_order_links AS
WITH ord AS (
  SELECT CASE WHEN platform = 'meesho' THEN 'meesho' ELSE 'flipkart' END AS fam,
         order_item_key, order_id, invoice_no, awb
    FROM orders
),
loose AS (
  SELECT fam, from_key, MAX(invoice_no) AS invoice_no, MAX(tracking_id) AS tracking_id, MAX(order_id) AS order_id
    FROM (
      SELECT CASE WHEN s.platform = 'meesho' THEN 'meesho' ELSE 'flipkart' END AS fam, s.order_item_key AS from_key,
             s.invoice_no, NULL AS tracking_id, s.order_id
        FROM settlement_lines s WHERE s.order_item_key IS NOT NULL
      UNION ALL
      SELECT CASE WHEN r.platform = 'meesho' THEN 'meesho' ELSE 'flipkart' END, r.order_item_key,
             r.invoice_no, r.tracking_id, r.order_id
        FROM returns r WHERE r.order_item_key IS NOT NULL
    ) x
   WHERE NOT EXISTS (SELECT 1 FROM ord o WHERE o.fam = x.fam AND o.order_item_key = x.from_key)
   GROUP BY fam, from_key
),
candidates AS (
  SELECT l.fam, l.from_key, 1 AS step, 'invoice' AS via, o.order_item_key AS to_key
    FROM loose l JOIN ord o ON o.fam = l.fam AND o.invoice_no = l.invoice_no
  UNION ALL
  SELECT l.fam, l.from_key, 2, 'awb', o.order_item_key
    FROM loose l JOIN ord o ON o.fam = l.fam AND o.awb = l.tracking_id
  UNION ALL
  SELECT l.fam, l.from_key, 3, 'order id', o.order_item_key
    FROM loose l JOIN ord o ON l.fam = 'flipkart' AND o.fam = 'flipkart' AND o.order_id = l.order_id
),
single AS (
  SELECT fam, from_key, step, via, MIN(to_key) AS to_key
    FROM candidates GROUP BY fam, from_key, step, via HAVING COUNT(DISTINCT to_key) = 1
)
SELECT s.fam, s.from_key, s.to_key, s.via
  FROM single s
 WHERE s.step = (SELECT MIN(step) FROM single s2 WHERE s2.fam = s.fam AND s2.from_key = s.from_key);

-- Any code as written → the canonical code. Codes resolve to themselves; aliases to
-- their target. A raw code missing from both is an unknown code.
CREATE VIEW v_code_resolved AS
  SELECT code AS raw, code FROM sku_codes
  UNION ALL
  SELECT alias AS raw, code FROM sku_aliases;

CREATE VIEW v_catalog AS
  SELECT s.code, s.display_code, s.is_set_listing, s.mrp_paise, s.flipkart_price_paise,
         s.meesho_price_paise, s.source AS code_source, s.note AS code_note,
         v.id AS variant_id, v.label AS variant_label, v.pack_of,
         p.id AS product_id, p.slug AS product_slug, p.name AS product_name,
         c.id AS category_id, c.name AS category_name
    FROM sku_codes s
    LEFT JOIN variants v ON v.id = s.variant_id
    LEFT JOIN products p ON p.id = v.product_id
    LEFT JOIN categories c ON c.id = p.category_id;

-- The whole stock history of every stock item, in pieces.
--
-- Only manual moves are stored. Dispatches come from orders and restocks from closed
-- returns, through each code's pack recipe — so a WH_4MFO sale takes 4 Black Floral
-- pieces and a WH_MFO_SET sale takes 2 from the same shelf. Because they are derived,
-- reverting an import or fixing a recipe corrects stock with no extra bookkeeping.
--
-- A return is only restocked when its order is in the database. A return for an
-- order invoiced before the app existed was never deducted, and adding it back would
-- inflate stock.
CREATE VIEW v_stock_ledger AS
  SELECT m.stock_item_id, m.qty, m.kind, m.move_date, 'manual' AS ref_type,
         CAST(m.id AS TEXT) AS ref_key
    FROM stock_moves m
  UNION ALL
  SELECT r.stock_item_id, -(r.qty * o.qty), 'dispatch',
         COALESCE(o.invoice_date, o.order_date), 'order', o.natural_key
    FROM orders o
    JOIN v_code_resolved rc ON rc.raw = o.code
    JOIN pack_recipes r ON r.code = rc.code
   WHERE o.cancelled = 0
  UNION ALL
  SELECT r.stock_item_id, (r.qty * rt.qty), 'restock', rt.closed_date, 'return', rt.natural_key
    FROM returns rt
    JOIN orders o ON o.platform IN (
           CASE WHEN rt.platform = 'meesho' THEN 'meesho' ELSE 'flipkart' END,
           CASE WHEN rt.platform = 'meesho' THEN 'meesho' ELSE 'shopsy' END)
         AND o.order_item_key = COALESCE(
               (SELECT lk.to_key FROM v_order_links lk
                 WHERE lk.fam = CASE WHEN rt.platform = 'meesho' THEN 'meesho' ELSE 'flipkart' END
                   AND lk.from_key = rt.order_item_key),
               rt.order_item_key)
         AND o.cancelled = 0
    JOIN v_code_resolved rc ON rc.raw = COALESCE(rt.code, o.code)
    JOIN pack_recipes r ON r.code = rc.code
   WHERE rt.status = 'closed'
     AND rt.outcome = 'received'
     AND COALESCE(rt.condition,
                  (SELECT value FROM settings WHERE key = 'default_return_condition'),
                  'good') = 'good';

-- A shelf's latest opening count resets it: on hand is that count plus every move
-- dated on or after it. A count is taken at the start of its day, so that day's
-- dispatches come off it; anything earlier is already in what was counted. This
-- matters because orders reports and payment files reach back weeks before the
-- first count. A shelf never counted adds up its whole history.
CREATE VIEW v_stock_on_hand AS
  WITH counted AS (
    SELECT stock_item_id, MAX(move_date) AS counted_on FROM stock_moves WHERE kind = 'opening' GROUP BY stock_item_id
  )
  SELECT si.id AS stock_item_id, si.key, si.name, si.product_id, si.reorder_level, c.counted_on,
         COALESCE(SUM(CASE WHEN c.counted_on IS NULL THEN l.qty
                           WHEN l.kind = 'opening' THEN CASE WHEN l.move_date = c.counted_on THEN l.qty ELSE 0 END
                           WHEN l.move_date >= c.counted_on THEN l.qty
                           ELSE 0 END), 0) AS on_hand
    FROM stock_items si
    LEFT JOIN counted c ON c.stock_item_id = si.id
    LEFT JOIN v_stock_ledger l ON l.stock_item_id = si.id
   GROUP BY si.id;
