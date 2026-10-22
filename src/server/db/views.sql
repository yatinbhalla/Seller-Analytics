-- Views are dropped and recreated on every start, so they can change without a
-- migration. Tables live in schema.sql.

DROP VIEW IF EXISTS v_code_resolved;
DROP VIEW IF EXISTS v_catalog;
DROP VIEW IF EXISTS v_stock_ledger;
DROP VIEW IF EXISTS v_stock_on_hand;

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
         AND o.order_item_key = rt.order_item_key AND o.cancelled = 0
    JOIN v_code_resolved rc ON rc.raw = COALESCE(rt.code, o.code)
    JOIN pack_recipes r ON r.code = rc.code
   WHERE rt.status = 'closed'
     AND rt.outcome = 'received'
     AND COALESCE(rt.condition,
                  (SELECT value FROM settings WHERE key = 'default_return_condition'),
                  'good') = 'good';

CREATE VIEW v_stock_on_hand AS
  SELECT si.id AS stock_item_id, si.key, si.name, si.product_id, si.reorder_level,
         COALESCE(SUM(l.qty), 0) AS on_hand
    FROM stock_items si
    LEFT JOIN v_stock_ledger l ON l.stock_item_id = si.id
   GROUP BY si.id;
