import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { openDb } from '../src/server/db/db.js';
import { syncCatalog } from '../src/server/catalog/sync.js';
import { stageFiles } from '../src/server/importers/stage.js';
import { commitImports } from '../src/server/importers/commit.js';
import { readPdfPages } from '../src/server/importers/pdf.js';
import { overview, pnl, products } from '../src/server/metrics/reports.js';
import './helpers.js';

/**
 * Golden tests on the seller's real exports in samples/ (gitignored). Every expected
 * figure is read from the file itself with code that shares nothing with the
 * importers, so the tests keep working when newer samples replace these.
 *
 * Skipped when samples/ is empty.
 */
const DIRS = ['samples/flipkart', 'samples/meesho'];
const files = DIRS.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).map((f) => path.join(d, f)) : []));
const has = files.length > 0;
const read = (f) => ({ fileName: path.basename(f), buffer: fs.readFileSync(f) });
const byKind = (staged, kind) => staged.filter((s) => s.summary?.kind === kind);
const num = (v) => Number(String(v ?? '').replace(/[₹,\s]/g, '')) || 0;

function catalogDb() {
  const db = openDb(':memory:');
  syncCatalog(db, { flipkartDir: process.env.LISTER_FLIPKART_DIR || 'F:/Claude/Flipkart', meeshoDir: process.env.LISTER_MEESHO_DIR || 'F:/Claude/Meesho' });
  return db;
}

function sheetsOf(file) {
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer', dense: true });
  return Object.fromEntries(wb.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null })]));
}

describe.skipIf(!has)("the seller's real sample files", async () => {
  const db = catalogDb();
  const staged = has ? await stageFiles(db, files.map(read)) : [];
  if (has) await commitImports(db, staged.filter((s) => s.status === 'staged').map((s) => s.importId));
  // Each label PDF is read once and shared; the Meesho one is 59 pages.
  const pdfPages = {};
  for (const f of files.filter((x) => x.endsWith('.pdf'))) pdfPages[path.basename(f)] = await readPdfPages(fs.readFileSync(f));

  it('recognises every file and sets no row aside', () => {
    for (const s of staged) {
      expect(s.status, `${s.fileName}: ${s.error || ''}`).not.toBe('failed');
      if (s.summary) expect(s.summary.rejected, s.fileName).toBe(0);
    }
  });

  it("Flipkart settlement: the database total equals the report's own Net Bank Settlement", () => {
    for (const s of byKind(staged, 'flipkart.settlement')) {
      const file = files.find((f) => path.basename(f) === s.fileName);
      const summary = sheetsOf(file)['Summary of report'];
      const row = summary.find((r) => r && r.some((c) => /net bank settlement/i.test(String(c ?? ''))));
      const expected = Math.round(num(row.find((c, i) => i > 0 && typeof c === 'number')) * 100);
      const got = db.prepare('SELECT SUM(net_paise) AS n FROM settlement_lines WHERE import_id = ?').get(s.importId).n;
      expect(got).toBe(expected);
    }
  });

  it('TCS and TDS match what the payment files say was held back', () => {
    for (const s of byKind(staged, 'flipkart.settlement')) {
      const summary = sheetsOf(files.find((f) => path.basename(f) === s.fileName))['Summary of report'];
      // The label sits in whichever break-up column it belongs to; its amount is the
      // first number to its right.
      const figure = (label) => {
        const row = summary.find((r) => r && r.some((c) => String(c ?? '').trim() === label));
        const at = row.findIndex((c) => String(c ?? '').trim() === label);
        return Math.round(num(row.slice(at + 1).find((c) => typeof c === 'number')) * 100);
      };
      const got = db.prepare('SELECT SUM(tcs_paise) AS tcs, SUM(tds_paise) AS tds FROM settlement_lines WHERE import_id = ?').get(s.importId);
      // Flipkart works in fractions of a paisa and rounds each line, so allow ½ paisa a line.
      const lines = db.prepare('SELECT COUNT(*) AS n FROM settlement_lines WHERE import_id = ?').get(s.importId).n;
      expect(Math.abs(got.tcs - figure('TCS'))).toBeLessThanOrEqual(Math.ceil(lines / 2));
      expect(Math.abs(got.tds - figure('TDS'))).toBeLessThanOrEqual(Math.ceil(lines / 2));
    }
    for (const s of byKind(staged, 'meesho.payments')) {
      const orders = sheetsOf(files.find((f) => path.basename(f) === s.fileName))['Order Payments'];
      const head = orders.findIndex((r) => r && r.includes('Sub Order No'));
      const col = (n) => orders[head].indexOf(n);
      const rows = orders.slice(head + 1).filter((r) => r && /_\d+$/.test(String(r[0] ?? '')));
      const total = (n) => rows.reduce((a, r) => a + Math.round(num(r[col(n)]) * 100), 0);
      const got = db.prepare('SELECT SUM(tcs_paise) AS tcs, SUM(tds_paise) AS tds FROM settlement_lines WHERE import_id = ?').get(s.importId);
      expect(got).toEqual({ tcs: total('TCS'), tds: total('TDS') });
    }
  });

  it('Meesho payments: order lines and ads each equal the file totals', () => {
    for (const s of byKind(staged, 'meesho.payments')) {
      const sheets = sheetsOf(files.find((f) => path.basename(f) === s.fileName));
      const orders = sheets['Order Payments'];
      const head = orders.findIndex((r) => r && r.includes('Sub Order No'));
      const finalCol = orders[head].indexOf('Final Settlement Amount');
      const expected = orders.slice(head + 1).filter((r) => r && /_\d+$/.test(String(r[0] ?? ''))).reduce((a, r) => a + Math.round(num(r[finalCol]) * 100), 0);
      const got = db.prepare("SELECT SUM(net_paise) AS n FROM settlement_lines WHERE import_id = ? AND order_item_key IS NOT NULL").get(s.importId).n;
      expect(got).toBe(expected);

      const ads = sheets['Ads Cost'] || [];
      const ah = ads.findIndex((r) => r && r.includes('Total Ads Cost'));
      if (ah !== -1) {
        const col = ads[ah].indexOf('Total Ads Cost');
        const adsExpected = -ads.slice(ah + 1).reduce((a, r) => a + Math.abs(Math.round(num(r?.[col]) * 100)), 0);
        expect(db.prepare("SELECT SUM(net_paise) AS n FROM settlement_lines WHERE import_id = ? AND txn_type = 'ads'").get(s.importId).n ?? 0).toBe(adsExpected);
      }
    }
  });

  it("every payment line's parts add up to its payout", () => {
    const bad = db.prepare(`SELECT COUNT(*) AS n FROM settlement_lines WHERE sale_paise + refund_paise + commission_paise + fixed_fee_paise
      + shipping_paise + reverse_ship_paise + collection_paise + tax_withheld_paise + penalty_paise + claim_paise + ads_paise + other_paise <> net_paise`).get().n;
    expect(bad).toBe(0);
  });

  it('reads one order per invoice in every label PDF, with totals matching the printed totals', async () => {
    for (const s of [...byKind(staged, 'flipkart.invoices'), ...byKind(staged, 'meesho.invoices')]) {
      const pages = pdfPages[s.fileName];
      const text = pages.map((p) => p.lines.join('\n')).join('\n');
      const ids = new Set(text.match(s.summary.kind === 'meesho.invoices' ? /\b\d{10,22}_\d{1,3}\b/g : /\bOD\d{12,22}\b/g));
      expect(s.summary.invoicesFound + s.summary.batchDupes, s.fileName).toBeGreaterThanOrEqual(ids.size);
    }
    // Meesho: the sum of each page's printed "Total" equals what was imported.
    for (const s of byKind(staged, 'meesho.invoices')) {
      const pages = pdfPages[s.fileName];
      let printed = 0;
      for (const p of pages) {
        const line = p.lines.find((l) => /^total\b/i.test(l));
        const vals = [...line.matchAll(/Rs\.(\d[\d,]*\.\d{2})/g)];
        printed += Math.round(num(vals[vals.length - 1][1]) * 100);
      }
      const other = db.prepare('SELECT SUM(total_paise) AS n FROM orders WHERE import_id = ?').get(s.importId).n;
      // Printed totals include "Other Charges" (logistics fee), which are not product lines.
      expect(other).toBeLessThanOrEqual(printed);
      expect(printed - other).toBeLessThan(pages.length * 5000);
    }
  });

  it('gives every invoice line a date, a real invoice number and its own packet', () => {
    const rows = db.prepare('SELECT invoice_no, invoice_date, shipment_key FROM orders').all();
    for (const r of rows) {
      expect(r.invoice_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.invoice_no).toMatch(/\d/);
    }
    // A packet is keyed by its invoice number (or order ID), never by a heading word
    // that would make unrelated packets share one ₹7.
    for (const r of rows) expect(r.shipment_key).toMatch(/\d{4,}/);
  });

  it('keeps no buyer name or street in the database', async () => {
    const dump = JSON.stringify(db.prepare('SELECT * FROM orders').all()) + JSON.stringify(db.prepare('SELECT * FROM returns').all());
    for (const s of [...byKind(staged, 'flipkart.invoices'), ...byKind(staged, 'meesho.invoices')]) {
      const pages = pdfPages[s.fileName];
      for (const p of pages) {
        const i = p.lines.findIndex((l) => /customer\s*address|shipping\/customer address/i.test(l));
        const nameLine = p.lines[i + 1] || '';
        const name = nameLine.replace(/^Name:\s*/i, '').replace(/,.*$/, '').trim();
        if (name.length > 4) expect(dump.includes(name), `buyer name from ${s.fileName}`).toBe(false);
      }
    }
  });

  it('a second upload of every file is refused as already imported', async () => {
    const again = await stageFiles(db, files.map(read));
    for (const s of again) expect(['already_imported', 'duplicate_in_batch'], s.fileName).toContain(s.status);
  });

  it('the same CSV rows in a new download (different bytes) change nothing', async () => {
    const before = db.prepare('SELECT natural_key, content_hash FROM returns ORDER BY natural_key').all();
    const csvs = files.filter((f) => f.endsWith('.csv')).map((f) => ({ fileName: `again-${path.basename(f)}`, buffer: Buffer.concat([fs.readFileSync(f), Buffer.from('\n')]) }));
    const res = await stageFiles(db, csvs);
    for (const s of res) {
      expect(s.status).toBe('staged');
      expect(s.summary.new + s.summary.update + s.summary.money_changed, s.fileName).toBe(0);
    }
    await commitImports(db, res.map((s) => s.importId));
    expect(db.prepare('SELECT natural_key, content_hash FROM returns ORDER BY natural_key').all()).toEqual(before);
  });

  it('returns from the created and closure files merge: one row per return', () => {
    for (const platform of ['meesho', 'flipkart']) {
      const keys = new Set();
      for (const s of staged.filter((x) => x.summary?.kind === `${platform}.returns`)) {
        const f = files.find((x) => path.basename(x) === s.fileName);
        const rows = XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(f, 'utf8'), { type: 'string', raw: true }).Sheets.Sheet1, { header: 1, defval: null });
        const head = rows.findIndex((r) => r && (r.includes('Suborder Number') || r.includes('Return ID')));
        const col = rows[head].indexOf(platform === 'meesho' ? 'Suborder Number' : 'Return ID');
        rows.slice(head + 1).forEach((r) => r?.[col] && keys.add(String(r[col])));
      }
      const got = db.prepare(`SELECT COUNT(*) AS n FROM returns WHERE platform ${platform === 'meesho' ? "= 'meesho'" : "IN ('flipkart','shopsy')"}`).get().n;
      expect(got, platform).toBe(keys.size);
    }
  });

  it('reports add up: platforms to the total, and the P&L steps to the profit', () => {
    const o = overview(db, {});
    expect(o.platforms.reduce((a, p) => a + p.gmv, 0)).toBe(o.total.gmv);
    expect(o.platforms.reduce((a, p) => a + p.payout, 0)).toBe(o.total.payout);
    const w = pnl(db, {}).total;
    expect(w.steps.filter((s) => !s.subtotal).reduce((a, s) => a + s.value, 0)).toBe(w.profit);
    const p = products(db, {});
    expect(p.rows.reduce((a, r) => a + (r.metrics.all?.gmv || 0), 0)).toBe(o.total.gmv);
  });
});
