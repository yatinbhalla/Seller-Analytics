-- Seller Analytics schema.
--
-- Conventions that every query relies on:
--   * Money is INTEGER paise. Never REAL — ₹0.1 + ₹0.2 must equal ₹0.3 to the paisa
--     when a payment file is reconciled against the database.
--   * Dates are TEXT 'YYYY-MM-DD'; timestamps are TEXT ISO-8601.
--   * SKU codes are stored normalised (trimmed, upper case). `sku` keeps the full
--     marketplace SKU as written; `code` is the part before the last '/'.
--   * platform is one of 'flipkart' | 'shopsy' | 'meesho'. Shopsy is its own
--     platform for analysis even though its files arrive through Flipkart.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─── Catalog ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS categories (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- A product is a design family: every pack size and every listing type of one design.
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('lister', 'manual')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A variant is one sellable configuration of a product: a pack size or a dimension.
CREATE TABLE IF NOT EXISTS variants (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  pack_of    INTEGER NOT NULL DEFAULT 1 CHECK (pack_of > 0),
  UNIQUE (product_id, label)
);

-- A SKU code is what precedes '/' in a marketplace SKU. Several codes can point at
-- one variant: WH_MFO and WH_MFO_SET are the same 2-pack, listed two ways.
CREATE TABLE IF NOT EXISTS sku_codes (
  code               TEXT PRIMARY KEY,
  display_code       TEXT NOT NULL,
  variant_id         INTEGER REFERENCES variants(id) ON DELETE SET NULL,
  is_set_listing     INTEGER NOT NULL DEFAULT 0,
  mrp_paise          INTEGER,
  flipkart_price_paise INTEGER,
  meesho_price_paise INTEGER,
  source             TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('lister', 'manual', 'import')),
  note               TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Old or misspelt codes resolve to a canonical one. `confirmed` = 0 means it was
-- assumed and still needs a yes on the SKU Mapping screen.
CREATE TABLE IF NOT EXISTS sku_aliases (
  alias     TEXT PRIMARY KEY,
  code      TEXT NOT NULL REFERENCES sku_codes(code) ON DELETE CASCADE,
  confirmed INTEGER NOT NULL DEFAULT 0,
  note      TEXT
);

-- Listing copies known from the listers' SKU ledgers (WH_MFO/40365 …).
CREATE TABLE IF NOT EXISTS listings (
  sku    TEXT PRIMARY KEY,
  code   TEXT NOT NULL,
  source TEXT NOT NULL
);

-- Cost price per unit as sold (a 4-pack's cost is the cost of four pieces).
-- Each change is a new row; an order uses the row in force on its date.
CREATE TABLE IF NOT EXISTS costs (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL REFERENCES sku_codes(code) ON DELETE CASCADE,
  cost_paise     INTEGER NOT NULL CHECK (cost_paise >= 0),
  effective_from TEXT NOT NULL,
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (code, effective_from)
);

-- ─── Stock ─────────────────────────────────────────────────────────────────────

-- A physical piece on the shelf: one design in one size.
CREATE TABLE IF NOT EXISTS stock_items (
  id              INTEGER PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
  reorder_level   INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- How many pieces of which stock item one unit of a code consumes.
CREATE TABLE IF NOT EXISTS pack_recipes (
  code          TEXT NOT NULL REFERENCES sku_codes(code) ON DELETE CASCADE,
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  qty           INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (code, stock_item_id)
);

-- Codes whose recipe could not be derived (mixed packs) wait here for the seller.
CREATE TABLE IF NOT EXISTS recipe_todo (
  code   TEXT PRIMARY KEY REFERENCES sku_codes(code) ON DELETE CASCADE,
  reason TEXT NOT NULL
);

-- Manual stock moves only. Dispatches and restocks are DERIVED from orders and
-- returns in v_stock_ledger, so undoing an import fixes stock automatically and the
-- two can never drift apart.
CREATE TABLE IF NOT EXISTS stock_moves (
  id              INTEGER PRIMARY KEY,
  stock_item_id   INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  qty             INTEGER NOT NULL CHECK (qty <> 0),
  kind            TEXT NOT NULL CHECK (kind IN ('opening', 'purchase', 'adjust', 'writeoff')),
  move_date       TEXT NOT NULL,
  unit_cost_paise INTEGER,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Imports ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS imports (
  id                 INTEGER PRIMARY KEY,
  sha256             TEXT NOT NULL,
  file_name          TEXT NOT NULL,
  stored_path        TEXT NOT NULL,
  kind               TEXT,
  platform           TEXT,
  status             TEXT NOT NULL CHECK (status IN ('staged', 'committed', 'reverted', 'discarded', 'failed')),
  rows_total         INTEGER NOT NULL DEFAULT 0,
  rows_new           INTEGER NOT NULL DEFAULT 0,
  rows_updated       INTEGER NOT NULL DEFAULT 0,
  rows_unchanged     INTEGER NOT NULL DEFAULT 0,
  rows_rejected      INTEGER NOT NULL DEFAULT 0,
  rows_money_changed INTEGER NOT NULL DEFAULT 0,
  rows_batch_dupes   INTEGER NOT NULL DEFAULT 0,
  money_total_paise  INTEGER,
  date_from          TEXT,
  date_to            TEXT,
  summary_json       TEXT,
  error              TEXT,
  staged_at          TEXT NOT NULL DEFAULT (datetime('now')),
  committed_at       TEXT,
  reverted_at        TEXT
);
-- One committed import per file. A second upload of the same bytes is "already imported".
CREATE UNIQUE INDEX IF NOT EXISTS imports_sha_committed ON imports(sha256) WHERE status = 'committed';

-- Parsed rows waiting for Commit. Nothing here is visible to analytics.
CREATE TABLE IF NOT EXISTS staged_rows (
  import_id   INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  row_no      TEXT NOT NULL,
  entity      TEXT NOT NULL CHECK (entity IN ('order', 'return', 'settlement')),
  natural_key TEXT NOT NULL,
  payload     TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('new', 'update', 'unchanged', 'money_changed')),
  diff        TEXT,
  accepted    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (import_id, entity, natural_key)
);

CREATE TABLE IF NOT EXISTS import_rows_rejected (
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  row_no    TEXT NOT NULL,
  reason    TEXT NOT NULL,
  raw       TEXT
);

-- Every insert and update a commit makes, with the row as it was before. Undo replays
-- these backwards.
CREATE TABLE IF NOT EXISTS row_versions (
  id          INTEGER PRIMARY KEY,
  import_id   INTEGER NOT NULL REFERENCES imports(id),
  entity      TEXT NOT NULL,
  natural_key TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('insert', 'update')),
  before_json TEXT,
  after_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS row_versions_key ON row_versions(entity, natural_key, id);
CREATE INDEX IF NOT EXISTS row_versions_import ON row_versions(import_id);

-- ─── Sales ─────────────────────────────────────────────────────────────────────

-- One row per invoiced line. natural_key = platform|account|order item key.
CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY,
  natural_key         TEXT NOT NULL UNIQUE,
  platform            TEXT NOT NULL CHECK (platform IN ('flipkart', 'shopsy', 'meesho')),
  account             TEXT NOT NULL DEFAULT 'main',
  order_item_key      TEXT NOT NULL,
  order_id            TEXT,
  shipment_key        TEXT NOT NULL,
  invoice_no          TEXT,
  invoice_date        TEXT,
  order_date          TEXT,
  sku                 TEXT NOT NULL,
  code                TEXT NOT NULL,
  qty                 INTEGER NOT NULL CHECK (qty > 0),
  gross_paise         INTEGER,
  discount_paise      INTEGER,
  taxable_paise       INTEGER,
  tax_paise           INTEGER,
  total_paise         INTEGER NOT NULL,
  ship_state          TEXT,
  ship_pincode        TEXT,
  cancelled           INTEGER NOT NULL DEFAULT 0,
  import_id           INTEGER NOT NULL REFERENCES imports(id),
  source_ref          TEXT,
  content_hash        TEXT NOT NULL,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS orders_code ON orders(code);
CREATE INDEX IF NOT EXISTS orders_date ON orders(invoice_date);
CREATE INDEX IF NOT EXISTS orders_item ON orders(platform, order_item_key);

-- One row per return, merged from the return-created and return-closure files.
CREATE TABLE IF NOT EXISTS returns (
  id               INTEGER PRIMARY KEY,
  natural_key      TEXT NOT NULL UNIQUE,
  platform         TEXT NOT NULL CHECK (platform IN ('flipkart', 'shopsy', 'meesho')),
  account          TEXT NOT NULL DEFAULT 'main',
  return_key       TEXT NOT NULL,
  order_item_key   TEXT,
  order_id         TEXT,
  sku              TEXT,
  code             TEXT,
  qty              INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  return_type      TEXT NOT NULL CHECK (return_type IN ('customer', 'rto')),
  reason           TEXT,
  sub_reason       TEXT,
  comments         TEXT,
  created_date     TEXT,
  closed_date      TEXT,
  status           TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  outcome          TEXT CHECK (outcome IN ('received', 'lost', 'claimed', 'cancelled')),
  condition        TEXT CHECK (condition IN ('good', 'damaged', 'missing')),
  condition_set_by TEXT CHECK (condition_set_by IN ('file', 'seller')),
  raw_status       TEXT,
  dispatch_date    TEXT,
  price_paise      INTEGER,
  invoice_no       TEXT,
  invoice_date     TEXT,
  import_id        INTEGER NOT NULL REFERENCES imports(id),
  source_ref       TEXT,
  content_hash     TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS returns_item ON returns(platform, order_item_key);

-- One row per money line in a payment or settlement file. Amounts are signed the way
-- they move the payout: deductions are negative.
CREATE TABLE IF NOT EXISTS settlement_lines (
  id                   INTEGER PRIMARY KEY,
  natural_key          TEXT NOT NULL UNIQUE,
  platform             TEXT NOT NULL CHECK (platform IN ('flipkart', 'shopsy', 'meesho')),
  account              TEXT NOT NULL DEFAULT 'main',
  order_item_key       TEXT,
  order_id             TEXT,
  sku                  TEXT,
  code                 TEXT,
  txn_type             TEXT NOT NULL,
  payment_date         TEXT,
  settlement_ref       TEXT,
  sale_paise           INTEGER NOT NULL DEFAULT 0,
  refund_paise         INTEGER NOT NULL DEFAULT 0,
  commission_paise     INTEGER NOT NULL DEFAULT 0,
  fixed_fee_paise      INTEGER NOT NULL DEFAULT 0,
  shipping_paise       INTEGER NOT NULL DEFAULT 0,
  reverse_ship_paise   INTEGER NOT NULL DEFAULT 0,
  collection_paise     INTEGER NOT NULL DEFAULT 0,
  tax_withheld_paise   INTEGER NOT NULL DEFAULT 0,   -- TCS + TDS; the two parts below
  tcs_paise            INTEGER,
  tds_paise            INTEGER,
  penalty_paise        INTEGER NOT NULL DEFAULT 0,
  claim_paise          INTEGER NOT NULL DEFAULT 0,
  ads_paise            INTEGER NOT NULL DEFAULT 0,
  other_paise          INTEGER NOT NULL DEFAULT 0,
  net_paise            INTEGER NOT NULL,
  -- What the payment file says about the order itself. When no invoice PDF was ever
  -- uploaded for it (orders shipped before the app was in use), these describe it.
  order_date           TEXT,
  dispatch_date        TEXT,
  qty                  INTEGER,
  gst_pct              REAL,
  invoice_no           TEXT,
  invoice_date         TEXT,
  breakdown_json       TEXT,
  import_id            INTEGER NOT NULL REFERENCES imports(id),
  source_ref           TEXT,
  content_hash         TEXT NOT NULL,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS settlement_item ON settlement_lines(platform, order_item_key);
-- The order-line query joins Flipkart and Shopsy as one family, so it matches on the
-- order item alone.
CREATE INDEX IF NOT EXISTS settlement_item_key ON settlement_lines(order_item_key);
CREATE INDEX IF NOT EXISTS orders_item_key ON orders(order_item_key);
CREATE INDEX IF NOT EXISTS returns_item_key ON returns(order_item_key);
CREATE INDEX IF NOT EXISTS settlement_order ON settlement_lines(platform, order_id);

-- ─── Events (Phase 2 uses these; the tables exist from day one) ────────────────

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  platform      TEXT,
  kind          TEXT,
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  discount_note TEXT,
  confirmed     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event_skus (
  event_id         INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  code             TEXT NOT NULL,
  deal_price_paise INTEGER,
  discount_pct     REAL,
  PRIMARY KEY (event_id, code)
);

-- ─── Alerts ────────────────────────────────────────────────────────────────────

-- The seller's decision on an alert (metrics/anomalies.js), by the alert's stable key
-- (type + the row it is about). Alerts themselves are computed fresh, never stored.
CREATE TABLE IF NOT EXISTS anomaly_reviews (
  key          TEXT PRIMARY KEY,
  status       TEXT NOT NULL CHECK (status IN ('ok', 'follow_up')),
  note         TEXT,
  reviewed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
