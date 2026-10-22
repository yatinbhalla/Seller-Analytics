import fs from 'fs';
import path from 'path';
import { codeFromPattern, normCode, parseSku } from './sku.js';
import { COST_EFFECTIVE_FROM, SEED_ALIASES, SEED_COSTS, SEED_EXTRA_CODES } from '../seed/costs.js';

/**
 * Build the catalog from the listers' own data.
 *
 * Reads, never writes:
 *   <flipkart lister>/data/paths/<id>/config.json — names, verticals, variants,
 *     SKU patterns, pack sizes, MRP and prices for Flipkart and Meesho
 *   <each lister>/data/used_skus.json — every listing SKU ever allocated
 *
 * Nothing else in those folders is opened — not .env, not profiles.json, not the
 * browser profiles.
 *
 * Safe to run again at any time. It only ADDS products, variants, codes, stock items,
 * recipes and costs that are missing, and refreshes list prices. Anything the seller
 * changed in Settings — a product name, a code moved to another product, a cost, a
 * recipe — is left alone.
 */
export function syncCatalog(db, opts = {}) {
  const flipkartDir = opts.flipkartDir ?? process.env.LISTER_FLIPKART_DIR;
  const meeshoDir = opts.meeshoDir ?? process.env.LISTER_MEESHO_DIR;
  const paths = opts.paths ?? readPaths(flipkartDir);
  const ledgers = opts.ledgers ?? [
    { source: 'flipkart-lister', skus: readLedger(flipkartDir) },
    { source: 'meesho-lister', skus: readLedger(meeshoDir) },
  ];

  const report = { products: 0, variants: 0, codes: 0, stockItems: 0, recipes: 0, costs: 0, listings: 0, todo: 0 };
  db.transaction(() => {
    const model = buildModel(paths);
    applyModel(db, model, report);
    applyExtras(db, report);
    applyAliases(db);
    applyCosts(db, report, opts.costs ?? SEED_COSTS);
    applyListings(db, ledgers, report);
  })();
  return report;
}

function readPaths(dir) {
  if (!dir) return [];
  const root = path.join(dir, 'data', 'paths');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const id of fs.readdirSync(root)) {
    const file = path.join(root, id, 'config.json');
    if (!fs.existsSync(file)) continue;
    try {
      out.push({ id, ...JSON.parse(fs.readFileSync(file, 'utf8')) });
    } catch {
      // A config being edited by hand mid-sync is skipped, not fatal; the next sync
      // picks it up.
    }
  }
  return out;
}

function readLedger(dir) {
  if (!dir) return [];
  const file = path.join(dir, 'data', 'used_skus.json');
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

// ─── From lister paths to products, variants and codes ────────────────────────

/** Variant axes that change the design, not the pack: such a path lists several products. */
const DESIGN_AXES = /^(brand )?colou?r$/i;
const MIXED = /\b(mix|mixed|assorted|random)\b/i;

export function buildModel(paths) {
  const products = new Map(); // slug → { slug, name, category, variants: Map(label → variant) }
  const codeOwner = new Map(); // code → { slug, label }
  const pending = []; // variants of multi-design paths, placed after single-design ones

  const isMultiDesign = (p) =>
    (p.variants || []).some((v) => v.axis && DESIGN_AXES.test(v.axis)) || /-(variation|set)$/.test(p.id);

  for (const p of paths) {
    if (isMultiDesign(p)) {
      for (const v of p.variants || []) pending.push({ p, v });
      continue;
    }
    const slug = familySlug(p.id);
    const product = ensureProduct(products, slug, p);
    for (const v of p.variants || []) addVariant(product, p, v, codeOwner);
  }

  // A variation listing's variant is the same item as some single-design listing:
  // AP_BLMF in apron-variation is the apron in apron-black-multi-floral. Join it to
  // that product. A _SET code (BM_W_BL_TD_SET) joins the product of its base code.
  for (const { p, v } of pending) {
    const code = codeFromPattern(v.skuPattern || p.skuPattern);
    if (!code) continue;
    const owner = codeOwner.get(code) || codeOwner.get(baseOfSet(code));
    if (owner) {
      const product = products.get(owner.slug);
      const variant = product.variants.get(owner.label);
      if (!variant.codes.some((c) => c.code === code)) {
        variant.codes.push(codeEntry(code, p, v, code !== owner.code));
      }
      codeOwner.set(code, { ...owner, code });
      continue;
    }
    const slug = `${familySlug(p.id)}-${slugify(v.key || v.label || code)}`;
    const product = ensureProduct(products, slug, { ...p, name: `${p.name} — ${v.label || v.key}` });
    addVariant(product, p, v, codeOwner);
  }
  return products;
}

function ensureProduct(products, slug, p) {
  let product = products.get(slug);
  if (!product) {
    product = { slug, name: productName(p), category: categoryOf(p), variants: new Map() };
    products.set(slug, product);
  } else if (p.id === slug) {
    // The path whose id IS the family slug names the family best — it is the one
    // that is not about a single pack size.
    product.name = productName(p);
  }
  return product;
}

function addVariant(product, p, v, codeOwner) {
  const code = codeFromPattern(v.skuPattern || p.skuPattern);
  if (!code) return;
  const label = cleanLabel(v.label || v.key || 'Single');
  let variant = product.variants.get(label);
  if (!variant) {
    variant = { label, packOf: packOf(p, v), stockKey: `${product.slug}|${sizeKey(label)}`, mixed: isMixed(p, v), codes: [] };
    product.variants.set(label, variant);
  }
  if (!variant.codes.some((c) => c.code === code)) variant.codes.push(codeEntry(code, p, v, /_SET(_\d+)?$/.test(code)));
  if (!codeOwner.has(code)) codeOwner.set(code, { slug: product.slug, label, code });
}

function codeEntry(code, p, v, isSet) {
  return {
    code,
    display: String(v.skuPattern || p.skuPattern).replace(/\/?\{X\}.*$/, ''),
    isSet,
    mrp: rupeesToPaise(v.mrp),
    flipkart: rupeesToPaise(v.sellingPrice),
    meesho: rupeesToPaise(p.meesho?.sellingPrice),
  };
}

/** wall-hanging-organizer-black-floral-2p → wall-hanging-organizer-black-floral */
export function familySlug(id) {
  return String(id).replace(/-(\d+p|\d+x\d+)$/i, '');
}

function baseOfSet(code) {
  return code.replace(/_SET(_\d+)?$/, '');
}

function productName(p) {
  return String(p.name || p.id)
    .replace(/,\s*pack of \d+\s*(?=\))/i, '')
    .trim();
}

function categoryOf(p) {
  const v = p.vertical || p.verticalPath || 'Uncategorised';
  return String(v).split('/').pop().trim() || 'Uncategorised';
}

function cleanLabel(label) {
  return String(label).replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
}

/**
 * Pieces in one unit. The variant's own packOf wins; then "Pack of N" in its label;
 * then "pack of N" in the product name (the Aasan mats are sold in twos but their
 * variants carry only a size).
 */
function packOf(p, v) {
  const own = Number(v.packOf);
  if (Number.isInteger(own) && own > 0) return own;
  const fromLabel = String(v.label || '').match(/pack of (\d+)/i);
  if (fromLabel) return Number(fromLabel[1]);
  const fromName = String(p.name || '').match(/pack of (\d+)/i);
  if (fromName) return Number(fromName[1]);
  return 1;
}

/**
 * The part of a variant label that is the physical piece, without the pack count.
 * "Pack of 2 - 10 x 30 inch" and "Pack of 4 - 10 x 30 inch" are the same piece, so
 * they share one stock item; "4 Seater - 40x60 inch" and "6 Seater - 60x90 inch" are
 * different pieces and do not.
 */
function sizeKey(label) {
  return (
    String(label)
      .toLowerCase()
      .replace(/pack of \d+/g, '')
      .replace(/[^a-z0-9]+/g, '') || 'piece'
  );
}

function isMixed(p, v) {
  return MIXED.test(`${v.label || ''} ${v.key || ''}`) || (MIXED.test(p.name || '') && packOf(p, v) > 1);
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function rupeesToPaise(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

// ─── Writing the model ────────────────────────────────────────────────────────

function applyModel(db, model, report) {
  const getCategory = db.prepare('SELECT id FROM categories WHERE name = ?');
  const addCategory = db.prepare('INSERT INTO categories (name) VALUES (?)');
  const getProduct = db.prepare('SELECT id FROM products WHERE slug = ?');
  const addProduct = db.prepare("INSERT INTO products (slug, name, category_id, source) VALUES (?, ?, ?, 'lister')");
  const getVariant = db.prepare('SELECT id FROM variants WHERE product_id = ? AND label = ?');
  const addVariant = db.prepare('INSERT INTO variants (product_id, label, pack_of) VALUES (?, ?, ?)');
  const getCode = db.prepare('SELECT code FROM sku_codes WHERE code = ?');
  const addCode = db.prepare(`
    INSERT INTO sku_codes (code, display_code, variant_id, is_set_listing, mrp_paise, flipkart_price_paise, meesho_price_paise, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'lister')`);
  const refreshPrices = db.prepare(`
    UPDATE sku_codes SET mrp_paise = COALESCE(?, mrp_paise),
      flipkart_price_paise = COALESCE(?, flipkart_price_paise),
      meesho_price_paise = COALESCE(?, meesho_price_paise)
    WHERE code = ?`);
  const getStock = db.prepare('SELECT id FROM stock_items WHERE key = ?');
  const addStock = db.prepare('INSERT INTO stock_items (key, name, product_id) VALUES (?, ?, ?)');
  const hasRecipe = db.prepare('SELECT 1 FROM pack_recipes WHERE code = ? LIMIT 1');
  const addRecipe = db.prepare('INSERT OR IGNORE INTO pack_recipes (code, stock_item_id, qty) VALUES (?, ?, ?)');
  const addTodo = db.prepare('INSERT OR IGNORE INTO recipe_todo (code, reason) VALUES (?, ?)');

  const categoryId = (name) => {
    const hit = getCategory.get(name);
    return hit ? hit.id : addCategory.run(name).lastInsertRowid;
  };

  for (const product of model.values()) {
    let productId = getProduct.get(product.slug)?.id;
    if (!productId) {
      productId = addProduct.run(product.slug, product.name, categoryId(product.category)).lastInsertRowid;
      report.products++;
    }
    for (const variant of product.variants.values()) {
      let variantId = getVariant.get(productId, variant.label)?.id;
      if (!variantId) {
        variantId = addVariant.run(productId, variant.label, variant.packOf).lastInsertRowid;
        report.variants++;
      }

      // A mixed pack draws on pieces the catalog cannot know (which two colours went
      // in?), so it gets a stock item of its own, counted in packs, and a to-do.
      const stockKey = variant.mixed ? `${variant.stockKey}|mixed` : variant.stockKey;
      let stockId = getStock.get(stockKey)?.id;
      if (!stockId) {
        // A product with one physical piece needs no size in its shelf name — the
        // variant label of a single-variant path is usually the whole description again.
        const pieces = new Set([...product.variants.values()].map((v) => v.stockKey));
        const name = variant.mixed
          ? `${product.name} — ${variant.label} (mixed pack)`
          : pieces.size === 1 ? product.name : stockItemName(product, variant);
        stockId = addStock.run(stockKey, name, productId).lastInsertRowid;
        report.stockItems++;
      }

      for (const c of variant.codes) {
        if (!getCode.get(c.code)) {
          addCode.run(c.code, c.display, variantId, c.isSet ? 1 : 0, c.mrp, c.flipkart, c.meesho);
          report.codes++;
        } else {
          refreshPrices.run(c.mrp, c.flipkart, c.meesho, c.code);
        }
        if (!hasRecipe.get(c.code)) {
          addRecipe.run(c.code, stockId, variant.mixed ? 1 : variant.packOf);
          report.recipes++;
          if (variant.mixed) {
            addTodo.run(c.code, 'Mixed pack — choose which pieces it uses, or keep counting it as its own pack');
            report.todo++;
          }
        }
      }
    }
  }
}

function stockItemName(product, variant) {
  const size = variant.label.replace(/pack of \d+\s*-?\s*/i, '').trim();
  return size && size.toLowerCase() !== 'single' ? `${product.name} — ${size}` : product.name;
}

function applyExtras(db, report) {
  for (const x of SEED_EXTRA_CODES) {
    const code = normCode(x.code);
    if (db.prepare('SELECT 1 FROM sku_codes WHERE code = ?').get(code)) continue;
    let product = db.prepare('SELECT id, name FROM products WHERE slug = ?').get(x.product);
    if (!product) {
      const cat = x.category || 'Uncategorised';
      db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(cat);
      const catId = db.prepare('SELECT id FROM categories WHERE name = ?').get(cat).id;
      const id = db
        .prepare("INSERT INTO products (slug, name, category_id, source) VALUES (?, ?, ?, 'manual')")
        .run(x.product, x.name || x.code, catId).lastInsertRowid;
      product = { id, name: x.name || x.code };
      report.products++;
    }
    let variant = db.prepare('SELECT id FROM variants WHERE product_id = ? AND label = ?').get(product.id, x.variant);
    if (!variant) {
      variant = { id: db.prepare('INSERT INTO variants (product_id, label, pack_of) VALUES (?, ?, ?)').run(product.id, x.variant, x.packOf).lastInsertRowid };
      report.variants++;
    }
    db.prepare("INSERT INTO sku_codes (code, display_code, variant_id, source, note) VALUES (?, ?, ?, 'manual', ?)").run(
      code, x.code, variant.id, x.note || null,
    );
    report.codes++;

    // shareWith: the same piece in another pack size (WH_P4 takes pieces from the
    // Mauve shelf). Otherwise the variant is a piece of its own — a 5 m roll is not a
    // 10 m roll — with a shelf keyed by product and variant.
    let stockId = x.shareWith
      ? db.prepare('SELECT stock_item_id FROM pack_recipes WHERE code = ? LIMIT 1').get(normCode(x.shareWith))?.stock_item_id
      : null;
    if (!stockId) {
      const key = `${x.product}|${x.variant.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
      stockId = db.prepare('SELECT id FROM stock_items WHERE key = ?').get(key)?.id;
      if (!stockId) {
        const multi = SEED_EXTRA_CODES.filter((o) => o.product === x.product).length > 1;
        const name = multi ? `${product.name} — ${x.variant}` : product.name;
        stockId = db.prepare('INSERT INTO stock_items (key, name, product_id) VALUES (?, ?, ?)').run(key, name, product.id).lastInsertRowid;
        report.stockItems++;
      }
    }
    db.prepare('INSERT OR IGNORE INTO pack_recipes (code, stock_item_id, qty) VALUES (?, ?, ?)').run(code, stockId, x.packOf);
    report.recipes++;
  }
}

function applyAliases(db) {
  const known = db.prepare('SELECT 1 FROM sku_codes WHERE code = ?');
  const add = db.prepare('INSERT OR IGNORE INTO sku_aliases (alias, code, confirmed, note) VALUES (?, ?, ?, ?)');
  for (const a of SEED_ALIASES) {
    const alias = normCode(a.alias);
    const code = normCode(a.code);
    // An alias that is itself a real code would make that code resolve two ways.
    if (known.get(alias) || !known.get(code)) continue;
    add.run(alias, code, a.confirmed ? 1 : 0, a.note);
  }
}

function applyCosts(db, report, costs) {
  const has = db.prepare('SELECT 1 FROM costs WHERE code = ? LIMIT 1');
  const known = db.prepare('SELECT 1 FROM sku_codes WHERE code = ?');
  const add = db.prepare("INSERT INTO costs (code, cost_paise, effective_from, note) VALUES (?, ?, ?, 'Seeded from the seller''s cost sheet')");
  for (const [raw, rupees] of Object.entries(costs)) {
    const code = normCode(raw);
    if (!known.get(code) || has.get(code)) continue;
    add.run(code, Math.round(rupees * 100), COST_EFFECTIVE_FROM);
    report.costs++;
  }
}

function applyListings(db, ledgers, report) {
  const add = db.prepare('INSERT OR IGNORE INTO listings (sku, code, source) VALUES (?, ?, ?)');
  for (const { source, skus } of ledgers) {
    for (const raw of skus) {
      const parsed = parseSku(raw);
      if (!parsed) continue;
      report.listings += add.run(parsed.sku, parsed.code, source).changes;
    }
  }
}
