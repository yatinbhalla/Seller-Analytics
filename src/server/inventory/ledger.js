import { localToday } from '../lib/today.js';

/**
 * Stock in pieces, per stock item (one design in one size).
 *
 * On hand = everything in v_stock_ledger: manual moves the seller enters (opening
 * count, purchases, adjustments, write-offs) plus dispatches and restocks derived
 * from orders and returns through each code's pack recipe.
 */
export function stockReport(db, today = localToday()) {
  const d14 = shift(today, -14);
  const d30 = shift(today, -30);
  const items = db
    .prepare(`SELECT oh.stock_item_id AS id, oh.key, oh.name, oh.product_id, oh.reorder_level, oh.on_hand,
                     p.name AS product_name, c.name AS category_name,
                     COALESCE((SELECT -SUM(l.qty) FROM v_stock_ledger l WHERE l.stock_item_id = oh.stock_item_id
                                AND l.kind = 'dispatch' AND l.move_date >= @d14), 0) AS out14,
                     COALESCE((SELECT -SUM(l.qty) FROM v_stock_ledger l WHERE l.stock_item_id = oh.stock_item_id
                                AND l.kind = 'dispatch' AND l.move_date >= @d30), 0) AS out30,
                     (SELECT COUNT(*) FROM stock_moves m WHERE m.stock_item_id = oh.stock_item_id AND m.kind = 'opening') AS has_opening
                FROM v_stock_on_hand oh
                LEFT JOIN products p ON p.id = oh.product_id
                LEFT JOIN categories c ON c.id = p.category_id
               ORDER BY c.name, p.name, oh.name`)
    .all({ d14, d30 });

  const recipes = db
    .prepare(`SELECT r.stock_item_id, r.code, r.qty, s.display_code, v.label AS variant_label,
                     (SELECT c.cost_paise FROM costs c WHERE c.code = r.code AND c.effective_from <= @today
                       ORDER BY c.effective_from DESC LIMIT 1) AS cost_paise
                FROM pack_recipes r
                JOIN sku_codes s ON s.code = r.code
                LEFT JOIN variants v ON v.id = s.variant_id
               ORDER BY r.qty, r.code`)
    .all({ today });
  const inTransit = db
    .prepare(`SELECT pr.stock_item_id, SUM(pr.qty * rt.qty) AS pieces
                FROM returns rt
                JOIN v_code_resolved rc ON rc.raw = rt.code
                JOIN pack_recipes pr ON pr.code = rc.code
               WHERE rt.status = 'open'
               GROUP BY pr.stock_item_id`)
    .all();
  const transitBy = new Map(inTransit.map((r) => [r.stock_item_id, r.pieces]));

  return items.map((it) => {
    const mine = recipes.filter((r) => r.stock_item_id === it.id);
    const packs = [...new Map(mine.map((r) => [r.qty, r])).values()].map((r) => ({
      packOf: r.qty,
      label: r.variant_label,
      possible: it.on_hand > 0 ? Math.floor(it.on_hand / r.qty) : 0,
    }));
    const perPiece = mine.find((r) => r.cost_paise != null);
    const pieceCost = perPiece ? Math.round(perPiece.cost_paise / perPiece.qty) : null;
    const dailyUse = it.out30 > 0 ? it.out30 / 30 : it.out14 / 14;
    const daysCover = dailyUse > 0 ? Math.floor(Math.max(it.on_hand, 0) / dailyUse) : null;
    const reorderAt = it.reorder_level ?? Math.ceil(dailyUse * 14);
    return {
      ...it,
      codes: mine.map((r) => ({ code: r.display_code, qty: r.qty })),
      packs,
      pieceCostPaise: pieceCost,
      valuePaise: pieceCost != null ? Math.max(it.on_hand, 0) * pieceCost : null,
      dailyUse: Math.round(dailyUse * 10) / 10,
      daysCover,
      low: it.on_hand <= reorderAt && dailyUse > 0,
      suggestedReorder: dailyUse > 0 ? Math.max(0, Math.ceil(dailyUse * 30) - Math.max(it.on_hand, 0)) : 0,
      inTransit: transitBy.get(it.id) || 0,
      negative: it.on_hand < 0,
    };
  });
}

const KINDS = new Set(['opening', 'purchase', 'adjust', 'writeoff']);

export function addMove(db, { stockItemId, qty, kind, date, unitCostPaise = null, note = null }) {
  if (!KINDS.has(kind)) throw new Error(`Unknown stock move "${kind}".`);
  const n = Number(qty);
  if (!Number.isInteger(n) || n === 0) throw new Error('Quantity must be a whole number other than 0.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Date must be YYYY-MM-DD.');
  // Pieces leave on a write-off and arrive on a purchase or opening count, whatever sign was typed.
  const signed = kind === 'writeoff' ? -Math.abs(n) : kind === 'adjust' ? n : Math.abs(n);
  if (!db.prepare('SELECT 1 FROM stock_items WHERE id = ?').get(stockItemId)) throw new Error('No such stock item.');
  return db
    .prepare('INSERT INTO stock_moves (stock_item_id, qty, kind, move_date, unit_cost_paise, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(stockItemId, signed, kind, date, unitCostPaise, note).lastInsertRowid;
}

export function stockHistory(db, stockItemId, limit = 200) {
  return db
    .prepare('SELECT * FROM v_stock_ledger WHERE stock_item_id = ? ORDER BY move_date DESC LIMIT ?')
    .all(stockItemId, limit);
}

export function deleteManualMove(db, moveId) {
  const r = db.prepare('DELETE FROM stock_moves WHERE id = ?').run(moveId);
  if (!r.changes) throw new Error('No such stock move.');
}

/**
 * Replace a code's recipe. components: [{ stockItemId, qty }]. Setting a recipe
 * clears the code's to-do. Stock recalculates by itself — dispatches are derived.
 */
export function setRecipe(db, code, components) {
  if (!components.length) throw new Error('A recipe needs at least one stock item.');
  db.transaction(() => {
    db.prepare('DELETE FROM pack_recipes WHERE code = ?').run(code);
    const add = db.prepare('INSERT INTO pack_recipes (code, stock_item_id, qty) VALUES (?, ?, ?)');
    for (const c of components) {
      const q = Number(c.qty);
      if (!Number.isInteger(q) || q < 1) throw new Error('Each recipe quantity must be a whole number of at least 1.');
      add.run(code, Number(c.stockItemId), q);
    }
    db.prepare('DELETE FROM recipe_todo WHERE code = ?').run(code);
  })();
}

function shift(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
