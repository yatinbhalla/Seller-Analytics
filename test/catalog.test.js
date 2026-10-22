import fs from 'fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/server/db/db.js';
import { syncCatalog } from '../src/server/catalog/sync.js';
import { SEED_COSTS } from '../src/server/seed/costs.js';
import { normCode } from '../src/server/catalog/sku.js';
import { makeDb } from './helpers.js';
import { addCode } from '../src/server/catalog/manage.js';

const LISTER = 'F:/Claude/Flipkart';
const hasLister = fs.existsSync(`${LISTER}/data/paths`);

describe.skipIf(!hasLister)("against the seller's real lister data", () => {
  const db = openDb(':memory:');
  syncCatalog(db, { flipkartDir: LISTER, meeshoDir: 'F:/Claude/Meesho' });

  it('resolves every SKU in both ledgers to a known code', () => {
    const unresolved = db.prepare('SELECT DISTINCT code FROM listings WHERE code NOT IN (SELECT raw FROM v_code_resolved)').all();
    expect(unresolved).toEqual([]);
  });

  it('gives every catalog code a cost, and the seeded figure for each', () => {
    expect(db.prepare('SELECT code FROM sku_codes WHERE code NOT IN (SELECT code FROM costs)').all()).toEqual([]);
    const cost = db.prepare('SELECT cost_paise FROM costs WHERE code = ?');
    for (const [code, rupees] of Object.entries(SEED_COSTS)) {
      const row = cost.get(normCode(code));
      if (row) expect(row.cost_paise).toBe(rupees * 100);
    }
  });

  it('puts all three organiser pack sizes and their SET codes on one shelf', () => {
    const rows = db.prepare(`SELECT r.code, r.qty, r.stock_item_id FROM pack_recipes r
                              WHERE r.code IN ('WH_1MFO','WH_MFO','WH_4MFO','WH_MFO_SET_1','WH_MFO_SET','WH_MFO_SET_4')`).all();
    expect(new Set(rows.map((r) => r.stock_item_id)).size).toBe(1);
    expect(Object.fromEntries(rows.map((r) => [r.code, r.qty]))).toEqual({
      WH_1MFO: 1, WH_MFO: 2, WH_4MFO: 4, WH_MFO_SET_1: 1, WH_MFO_SET: 2, WH_MFO_SET_4: 4,
    });
  });

  it('keeps the 40x60 and 60x90 PVC covers on separate shelves', () => {
    const a = db.prepare("SELECT stock_item_id FROM pack_recipes WHERE code = 'TC_BT'").get();
    const b = db.prepare("SELECT stock_item_id FROM pack_recipes WHERE code = 'TC_60*90_BT'").get();
    expect(a.stock_item_id).not.toBe(b.stock_item_id);
  });

  it('adds the codes first seen in the sample files, each with its cost and shelf', () => {
    const row = (code) => db.prepare(`SELECT cat.product_slug, (SELECT cost_paise FROM costs WHERE code = cat.code) AS cost, r.stock_item_id, r.qty
      FROM v_catalog cat JOIN pack_recipes r ON r.code = cat.code WHERE cat.code = ?`).get(code);
    expect(row('WH_NG')).toMatchObject({ cost: 10000, qty: 2 });
    expect(row('TC_NP')).toMatchObject({ cost: 5500, qty: 1 });
    expect(row('TC_NBG')).toMatchObject({ cost: 5500 });
    expect(row('PROBE')).toMatchObject({ cost: 10500 });
    // Two roll lengths of one print: one product, two shelves.
    expect(row('SL_GRF').product_slug).toBe(row('SL_5_GRF').product_slug);
    expect(row('SL_GRF').stock_item_id).not.toBe(row('SL_5_GRF').stock_item_id);
    expect([row('SL_GRF').cost, row('SL_5_GRF').cost]).toEqual([18000, 9000]);
    // The old Mauve codes still share the Mauve shelf.
    expect(row('WH_P4').stock_item_id).toBe(row('WH_P').stock_item_id);
  });

  it('is safe to run twice', () => {
    const again = syncCatalog(db, { flipkartDir: LISTER, meeshoDir: 'F:/Claude/Meesho' });
    expect(again).toMatchObject({ products: 0, codes: 0, costs: 0, recipes: 0 });
  });
});

describe('adding a new SKU code', () => {
  it('creates product, variant, shelf and cost, and refuses a duplicate', () => {
    const db = makeDb();
    addCode(db, { code: 'cushion_red', costRupees: 95, newProductName: 'Cushion Cover (red)', categoryName: 'Cushion Covers', variantLabel: 'Single', packOf: 1 });
    expect(db.prepare("SELECT cost_paise FROM costs WHERE code = 'CUSHION_RED'").get().cost_paise).toBe(9500);
    expect(db.prepare("SELECT qty FROM pack_recipes WHERE code = 'CUSHION_RED'").get().qty).toBe(1);
    expect(() => addCode(db, { code: 'CUSHION_RED', costRupees: 1 })).toThrow(/already/);
    expect(() => addCode(db, { code: 'X/123', costRupees: 1 })).toThrow(/without the listing number/);
  });
});
