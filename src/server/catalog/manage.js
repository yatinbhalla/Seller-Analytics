import { localToday } from '../lib/today.js';
import { normCode } from './sku.js';

/**
 * Everything the seller changes by hand in Settings → Products & Costs and SKU Mapping.
 * Catalog sync never overwrites any of it.
 */

export function listCatalog(db) {
  const today = localToday();
  return db
    .prepare(`SELECT cat.*,
                     (SELECT c.cost_paise FROM costs c WHERE c.code = cat.code AND c.effective_from <= @today
                       ORDER BY c.effective_from DESC LIMIT 1) AS cost_paise,
                     (SELECT c.effective_from FROM costs c WHERE c.code = cat.code AND c.effective_from <= @today
                       ORDER BY c.effective_from DESC LIMIT 1) AS cost_from,
                     (SELECT COUNT(*) FROM costs c WHERE c.code = cat.code) AS cost_versions,
                     (SELECT COUNT(*) FROM listings l WHERE l.code = cat.code) AS listing_copies,
                     (SELECT GROUP_CONCAT(a.alias, ', ') FROM sku_aliases a WHERE a.code = cat.code) AS aliases,
                     (SELECT GROUP_CONCAT(si.name || ' × ' || r.qty, '; ') FROM pack_recipes r
                        JOIN stock_items si ON si.id = r.stock_item_id WHERE r.code = cat.code) AS recipe,
                     (SELECT reason FROM recipe_todo t WHERE t.code = cat.code) AS recipe_todo
                FROM v_catalog cat
               ORDER BY cat.category_name, cat.product_name, cat.pack_of, cat.code`)
    .all({ today });
}

export function costHistory(db, code) {
  return db.prepare('SELECT * FROM costs WHERE code = ? ORDER BY effective_from DESC').all(normCode(code));
}

/**
 * A new cost from a date. Orders before that date keep the old cost; nothing about
 * past profit is rewritten.
 */
export function setCost(db, code, rupees, effectiveFrom, note = null) {
  const c = normCode(code);
  const paise = Math.round(Number(rupees) * 100);
  if (!Number.isFinite(paise) || paise < 0) throw new Error('Cost must be a number of rupees, 0 or more.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom || '')) throw new Error('Effective date must be YYYY-MM-DD.');
  if (!db.prepare('SELECT 1 FROM sku_codes WHERE code = ?').get(c)) throw new Error(`Unknown SKU code ${code}.`);
  db.prepare(`INSERT INTO costs (code, cost_paise, effective_from, note) VALUES (?, ?, ?, ?)
              ON CONFLICT(code, effective_from) DO UPDATE SET cost_paise = excluded.cost_paise, note = excluded.note`)
    .run(c, paise, effectiveFrom, note);
}

/**
 * Add a SKU code that the listers do not know: a brand-new product, or an old code
 * found in an upload. Creates the product and variant if asked to, a stock item if
 * none is given, the recipe, and the cost — in one transaction.
 *
 * input: {
 *   code, costRupees, effectiveFrom?,
 *   variantId?                         — join an existing variant, or
 *   productId? | newProductName + categoryName,  variantLabel, packOf
 *   stockItemId? (share pieces with an existing shelf) | newStockName
 * }
 */
export function addCode(db, input) {
  const code = normCode(input.code);
  if (!code) throw new Error('SKU code is empty.');
  if (code.includes('/')) throw new Error('Give the code without the listing number — WH_MFO, not WH_MFO/40365.');
  if (db.prepare('SELECT 1 FROM v_code_resolved WHERE raw = ?').get(code)) throw new Error(`${code} is already in the catalog.`);
  if (input.costRupees == null || input.costRupees === '') throw new Error('Give a cost for the new code.');

  return db.transaction(() => {
    let variantId = input.variantId ? Number(input.variantId) : null;
    let productId = input.productId ? Number(input.productId) : null;
    if (!variantId) {
      if (!productId) {
        const name = String(input.newProductName || '').trim();
        if (!name) throw new Error('Choose a product or name a new one.');
        const cat = String(input.categoryName || 'Uncategorised').trim();
        db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(cat);
        const catId = db.prepare('SELECT id FROM categories WHERE name = ?').get(cat).id;
        const slug = uniqueSlug(db, name);
        productId = db.prepare("INSERT INTO products (slug, name, category_id, source) VALUES (?, ?, ?, 'manual')").run(slug, name, catId).lastInsertRowid;
      }
      const label = String(input.variantLabel || 'Single').trim();
      const packOf = Math.max(1, Number(input.packOf) || 1);
      const hit = db.prepare('SELECT id FROM variants WHERE product_id = ? AND label = ?').get(productId, label);
      variantId = hit ? hit.id : db.prepare('INSERT INTO variants (product_id, label, pack_of) VALUES (?, ?, ?)').run(productId, label, packOf).lastInsertRowid;
    }
    const variant = db.prepare('SELECT * FROM variants WHERE id = ?').get(variantId);
    if (!variant) throw new Error('No such variant.');

    db.prepare("INSERT INTO sku_codes (code, display_code, variant_id, source, note) VALUES (?, ?, ?, 'manual', ?)")
      .run(code, String(input.code).trim(), variantId, input.note || null);

    let stockItemId = input.stockItemId ? Number(input.stockItemId) : null;
    if (!stockItemId) {
      const product = db.prepare('SELECT name, slug FROM products WHERE id = ?').get(variant.product_id);
      const name = String(input.newStockName || `${product.name}${variant.label !== 'Single' ? ' — ' + variant.label : ''}`);
      stockItemId = db.prepare('INSERT INTO stock_items (key, name, product_id) VALUES (?, ?, ?)')
        .run(`${product.slug}|${code.toLowerCase()}`, name, variant.product_id).lastInsertRowid;
    }
    db.prepare('INSERT INTO pack_recipes (code, stock_item_id, qty) VALUES (?, ?, ?)').run(code, stockItemId, variant.pack_of);
    setCost(db, code, input.costRupees, input.effectiveFrom || '2000-01-01', 'Added by the seller');
    return { code, variantId, stockItemId };
  })();
}

/** Point an old or misspelt code at an existing one, instead of making it a product. */
export function addAlias(db, alias, code, note = null) {
  const a = normCode(alias);
  const c = normCode(code);
  if (db.prepare('SELECT 1 FROM sku_codes WHERE code = ?').get(a)) throw new Error(`${a} is a code of its own; it cannot also be an alias.`);
  if (!db.prepare('SELECT 1 FROM sku_codes WHERE code = ?').get(c)) throw new Error(`Unknown SKU code ${code}.`);
  db.prepare(`INSERT INTO sku_aliases (alias, code, confirmed, note) VALUES (?, ?, 1, ?)
              ON CONFLICT(alias) DO UPDATE SET code = excluded.code, confirmed = 1, note = excluded.note`).run(a, c, note);
}

export function confirmAlias(db, alias, confirmed) {
  if (confirmed) {
    db.prepare('UPDATE sku_aliases SET confirmed = 1 WHERE alias = ?').run(normCode(alias));
  } else {
    db.prepare('DELETE FROM sku_aliases WHERE alias = ?').run(normCode(alias));
  }
}

export function renameProduct(db, productId, name) {
  if (!String(name || '').trim()) throw new Error('Name is empty.');
  db.prepare('UPDATE products SET name = ? WHERE id = ?').run(String(name).trim(), productId);
}

export function setProductCategory(db, productId, categoryName) {
  const cat = String(categoryName || '').trim();
  if (!cat) throw new Error('Category is empty.');
  db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(cat);
  const id = db.prepare('SELECT id FROM categories WHERE name = ?').get(cat).id;
  db.prepare('UPDATE products SET category_id = ? WHERE id = ?').run(id, productId);
}

export function moveCode(db, code, variantId) {
  const r = db.prepare('UPDATE sku_codes SET variant_id = ? WHERE code = ?').run(Number(variantId), normCode(code));
  if (!r.changes) throw new Error(`Unknown SKU code ${code}.`);
}

/** Codes seen in committed data that the catalog cannot resolve, with how often. */
export function unknownCodes(db) {
  return db
    .prepare(`SELECT code, MIN(sku) AS example_sku, SUM(n) AS seen, GROUP_CONCAT(DISTINCT platform) AS platforms FROM (
                SELECT code, sku, platform, COUNT(*) AS n FROM orders GROUP BY code, platform
                UNION ALL SELECT code, sku, platform, COUNT(*) FROM returns WHERE code IS NOT NULL GROUP BY code, platform
                UNION ALL SELECT code, sku, platform, COUNT(*) FROM settlement_lines WHERE code IS NOT NULL GROUP BY code, platform
              ) WHERE code NOT IN (SELECT raw FROM v_code_resolved)
              GROUP BY code ORDER BY seen DESC`)
    .all();
}

function uniqueSlug(db, name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'product';
  let slug = base;
  for (let i = 2; db.prepare('SELECT 1 FROM products WHERE slug = ?').get(slug); i++) slug = `${base}-${i}`;
  return slug;
}
