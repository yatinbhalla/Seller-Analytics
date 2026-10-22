import express from 'express';
import multer from 'multer';
import { getDb, getSetting, setSetting, backup, listBackups, restoreBackup, DEFAULT_SETTINGS } from '../db/db.js';
import { syncCatalog } from '../catalog/sync.js';
import {
  addAlias, addCode, confirmAlias, costHistory, listCatalog, moveCode, renameProduct, setCost, setProductCategory, unknownCodes,
} from '../catalog/manage.js';
import { stageFiles, discardImport, setAccepted } from '../importers/stage.js';
import { commitImports, revertImport } from '../importers/commit.js';
import { overview, products, productDetail, orderList, returnsReport, pnl, paymentsDue, taxCredits } from '../metrics/reports.js';
import { dataHealth } from '../metrics/health.js';
import { stockReport, addMove, stockHistory, deleteManualMove, setRecipe } from '../inventory/ledger.js';
import { aiConfigured } from '../ai/client.js';
import { ask, digest, returnThemes } from '../ai/insights.js';

const router = express.Router();
// Kept in memory: the file is hashed and stored by stage.js, never left half-written
// in an upload folder.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024, files: 40 } });

const wrap = (fn) => (req, res) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .then((out) => {
      if (!res.headersSent) res.json(out ?? { ok: true });
    })
    .catch((err) => res.status(err.status || 400).json({ error: err.message }));
};

function filters(q) {
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  return {
    from: date(q.from),
    to: date(q.to),
    platforms: q.platforms ? String(q.platforms).split(',').filter(Boolean) : [],
    categoryId: q.categoryId ? Number(q.categoryId) : null,
  };
}

// ─── Imports ───────────────────────────────────────────────────────────────────

router.post('/imports/stage', upload.array('files'), wrap(async (req) => {
  if (!req.files?.length) throw new Error('No files received.');
  return stageFiles(getDb(), req.files.map((f) => ({ buffer: f.buffer, fileName: Buffer.from(f.originalname, 'latin1').toString('utf8') })));
}));

router.get('/imports', wrap(() =>
  getDb().prepare(`SELECT id, file_name, kind, platform, status, rows_total, rows_new, rows_updated, rows_unchanged,
                          rows_rejected, rows_money_changed, rows_batch_dupes, money_total_paise, date_from, date_to,
                          error, staged_at, committed_at, reverted_at
                     FROM imports ORDER BY id DESC LIMIT 300`).all()));

// Files staged but not committed, e.g. by the nightly download when a file needs a
// decision. Same shape as /imports/stage returns, so the Import page shows them alike.
router.get('/imports/staged', wrap(() =>
  getDb().prepare("SELECT id, file_name, summary_json FROM imports WHERE status = 'staged' ORDER BY id").all()
    .map((r) => ({ fileName: r.file_name, status: 'staged', importId: r.id, summary: JSON.parse(r.summary_json) }))));

router.get('/imports/:id', wrap((req) => {
  const db = getDb();
  const imp = db.prepare('SELECT * FROM imports WHERE id = ?').get(req.params.id);
  if (!imp) throw Object.assign(new Error('No such import.'), { status: 404 });
  return {
    ...imp,
    summary: imp.summary_json ? JSON.parse(imp.summary_json) : null,
    moneyChanges: db.prepare("SELECT entity, natural_key, row_no, diff, accepted FROM staged_rows WHERE import_id = ? AND action = 'money_changed'").all(imp.id),
    sample: db.prepare("SELECT entity, natural_key, row_no, action, payload FROM staged_rows WHERE import_id = ? AND action IN ('new', 'update') LIMIT 25").all(imp.id)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) })),
    rejected: db.prepare('SELECT row_no, reason, raw FROM import_rows_rejected WHERE import_id = ? LIMIT 500').all(imp.id),
  };
}));

router.post('/imports/commit', wrap(async (req) => commitImports(getDb(), req.body.ids || [])));
router.post('/imports/:id/discard', wrap((req) => discardImport(getDb(), Number(req.params.id))));
router.post('/imports/:id/revert', wrap(async (req) => revertImport(getDb(), Number(req.params.id))));
router.post('/imports/:id/accept', wrap((req) =>
  setAccepted(getDb(), Number(req.params.id), req.body.entity, req.body.naturalKey, Boolean(req.body.accepted))));

// ─── Catalog, costs, SKU mapping ─────────────────────────────────────────────

router.get('/catalog', wrap(() => listCatalog(getDb())));
router.post('/catalog/sync', wrap(() => syncCatalog(getDb())));
router.get('/catalog/unknown', wrap(() => unknownCodes(getDb())));
router.post('/catalog/codes', wrap((req) => addCode(getDb(), req.body)));
router.get('/catalog/costs/:code', wrap((req) => costHistory(getDb(), req.params.code)));
router.post('/catalog/costs', wrap((req) => setCost(getDb(), req.body.code, req.body.rupees, req.body.effectiveFrom, req.body.note)));
router.get('/catalog/aliases', wrap(() => getDb().prepare('SELECT * FROM sku_aliases ORDER BY confirmed, alias').all()));
router.post('/catalog/aliases', wrap((req) => addAlias(getDb(), req.body.alias, req.body.code, req.body.note)));
router.post('/catalog/aliases/:alias/confirm', wrap((req) => confirmAlias(getDb(), req.params.alias, Boolean(req.body.confirmed))));
router.patch('/catalog/products/:id', wrap((req) => {
  const db = getDb();
  if (req.body.name) renameProduct(db, Number(req.params.id), req.body.name);
  if (req.body.category) setProductCategory(db, Number(req.params.id), req.body.category);
}));
router.post('/catalog/codes/:code/move', wrap((req) => moveCode(getDb(), req.params.code, req.body.variantId)));
router.get('/catalog/products', wrap(() => {
  const db = getDb();
  const prods = db.prepare('SELECT p.id, p.name, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY c.name, p.name').all();
  const variants = db.prepare('SELECT id, product_id, label, pack_of FROM variants ORDER BY pack_of, label').all();
  return prods.map((p) => ({ ...p, variants: variants.filter((v) => v.product_id === p.id) }));
}));
router.get('/catalog/categories', wrap(() => getDb().prepare('SELECT * FROM categories ORDER BY name').all()));
router.get('/catalog/stock-items', wrap(() => getDb().prepare('SELECT id, name, product_id FROM stock_items ORDER BY name').all()));

// ─── Reports ───────────────────────────────────────────────────────────────────

router.get('/reports/overview', wrap((req) => overview(getDb(), filters(req.query))));
router.get('/reports/products', wrap((req) => products(getDb(), filters(req.query))));
router.get('/reports/products/:id', wrap((req) => productDetail(getDb(), Number(req.params.id), filters(req.query))));
router.get('/reports/orders', wrap((req) => orderList(getDb(), filters(req.query), {
  q: req.query.q || '', status: req.query.status || '', limit: Math.min(Number(req.query.limit) || 200, 1000), offset: Number(req.query.offset) || 0,
})));
router.get('/reports/returns', wrap((req) => returnsReport(getDb(), filters(req.query))));
router.get('/reports/pnl', wrap((req) => pnl(getDb(), filters(req.query))));
router.get('/reports/health', wrap(() => dataHealth(getDb())));
router.get('/reports/payments-due', wrap((req) => paymentsDue(getDb(), filters(req.query))));
router.get('/reports/tax-credits', wrap((req) => taxCredits(getDb(), filters(req.query))));

/** The seller marks a returned item's condition after opening the parcel. */
router.patch('/returns/condition', wrap((req) => {
  const { naturalKey, condition } = req.body;
  if (!['good', 'damaged', 'missing', null].includes(condition ?? null)) throw new Error('Condition must be good, damaged or missing.');
  const r = getDb().prepare("UPDATE returns SET condition = ?, condition_set_by = 'seller', updated_at = datetime('now') WHERE natural_key = ?")
    .run(condition ?? null, naturalKey);
  if (!r.changes) throw new Error('No such return.');
}));

// ─── Stock ─────────────────────────────────────────────────────────────────────

router.get('/stock', wrap(() => stockReport(getDb())));
router.post('/stock/moves', wrap((req) => ({ id: addMove(getDb(), req.body) })));
router.delete('/stock/moves/:id', wrap((req) => deleteManualMove(getDb(), Number(req.params.id))));
router.get('/stock/:id/history', wrap((req) => stockHistory(getDb(), Number(req.params.id))));
router.post('/stock/recipes/:code', wrap((req) => setRecipe(getDb(), req.params.code, req.body.components || [])));
router.get('/stock/recipes/todo', wrap(() => getDb().prepare(`SELECT t.code, t.reason, cat.product_name, cat.variant_label, cat.pack_of
  FROM recipe_todo t LEFT JOIN v_catalog cat ON cat.code = t.code ORDER BY t.code`).all()));
router.patch('/stock/items/:id', wrap((req) => {
  const db = getDb();
  if (req.body.reorderLevel !== undefined) {
    db.prepare('UPDATE stock_items SET reorder_level = ? WHERE id = ?').run(req.body.reorderLevel === '' ? null : Number(req.body.reorderLevel), req.params.id);
  }
  if (req.body.name) db.prepare('UPDATE stock_items SET name = ? WHERE id = ?').run(String(req.body.name).trim(), req.params.id);
}));

// ─── Settings and backups ────────────────────────────────────────────────────

router.get('/settings', wrap(() => {
  const db = getDb();
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, getSetting(db, k)]));
}));
router.put('/settings', wrap((req) => {
  const db = getDb();
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!(k in DEFAULT_SETTINGS)) throw new Error(`Unknown setting ${k}.`);
    setSetting(db, k, v);
  }
}));
router.get('/backups', wrap(() => listBackups()));
router.post('/backups', wrap(async () => ({ file: await backup(getDb(), 'manual') })));
router.post('/backups/restore', wrap(async (req) => {
  await restoreBackup(req.body.file);
}));

// ─── AI ──────────────────────────────────────────────────────────────────────

router.get('/ai/status', wrap(() => ({ configured: aiConfigured() })));
router.post('/ai/ask', wrap(async (req) => ask(getDb(), String(req.body.message || ''), req.body.history || [])));
router.post('/ai/digest', wrap(async (req) => digest(getDb(), req.body)));
router.post('/ai/return-themes', wrap(async (req) => returnThemes(getDb(), req.body)));

export default router;
