/**
 * The local half of the nightly download (the Claude scheduled task "Nightly
 * marketplace download" does the browsing in Chrome, per docs/auto-download.md).
 *
 *   node src/fetch/nightly.js plan            what to download tonight, as JSON
 *   node src/fetch/nightly.js import [files]  import tonight's downloads, as JSON
 *   node src/fetch/nightly.js mark <step> <date>   record a step as done up to <date>
 *   node src/fetch/nightly.js status          the saved state
 *
 * Catch-up lives here, not in the browsing: each step remembers the last day it got
 * (data/fetch-state.json), and payments are checked against what the database already
 * holds, so a night the PC was off is fetched the next time without anyone counting.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// The app's data folder is relative to the project, wherever this is started from.
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
await import('dotenv/config');
const { DATA_DIR, getDb, integrityCheck } = await import('../server/db/db.js');
const { syncCatalog } = await import('../server/catalog/sync.js');
const { stageFiles } = await import('../server/importers/stage.js');
const { commitImports } = await import('../server/importers/commit.js');
const { localToday } = await import('../server/lib/today.js');
const { findAnomalies } = await import('../server/metrics/anomalies.js');

const STATE_FILE = path.join(DATA_DIR, 'fetch-state.json');
const RUN_FILE = path.join(DATA_DIR, 'fetch', 'run.json');
const DOWNLOADS = process.env.FETCH_DOWNLOADS_DIR || path.join(os.homedir(), 'Downloads');

/** Steps that remember the last day they covered. Payments are checked against the database instead. */
const STEPS = [
  'meesho.delivered', 'meesho.intransit', 'meesho.payments',
  'flipkart.returnsClosed', 'flipkart.returnsCreated', 'flipkart.cancellations', 'flipkart.payments',
];

/** What each night's downloads are called — anything else in Downloads is left alone. */
const DOWNLOAD_NAMES = [
  /^completed_delivered.*\.csv$/i,
  /^intransit.*\.csv$/i,
  /^meesho_.*PAYMENT.*\.zip$/i,
  /^off-returns-all-api_.*\.csv$/i,
  /^Cancelled-Orders.*\.csv$/i,
  /^Orders_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}_.*\.csv$/i, // Meesho orders report
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_\d+( \(\d+\))?\.xlsx$/i, // Flipkart payment reports
];

const [cmd, ...args] = process.argv.slice(2);
const out = (obj) => console.log(JSON.stringify(obj, null, 2));

try {
  if (cmd === 'plan') out(plan());
  else if (cmd === 'import') out(await importDownloads(args));
  else if (cmd === 'mark') out(mark(args[0], args[1]));
  else if (cmd === 'status') out(readJson(STATE_FILE, {}));
  else {
    console.error('Usage: node src/fetch/nightly.js plan | import [files…] | mark <step> <YYYY-MM-DD> | status');
    process.exit(64);
  }
} catch (err) {
  out({ ok: false, error: err.message });
  process.exit(1);
}

// ─── plan ──────────────────────────────────────────────────────────────────────

function plan() {
  const db = openChecked();
  const state = readJson(STATE_FILE, {});
  const today = localToday();
  const yesterday = addDays(today, -1);
  // First run: yesterday for returns, the last 30 days for payments (what both lists show).
  const from = (step, firstRunDays = 1) => (state[step] ? addDays(state[step], 1) : addDays(today, -firstRunDays));
  const range = (step, firstRunDays) => {
    const f = from(step, firstRunDays);
    return f > yesterday ? null : { from: f, to: yesterday, days: daysBetween(f, yesterday) + 1 };
  };

  fs.mkdirSync(path.dirname(RUN_FILE), { recursive: true });
  const startedAt = new Date().toISOString();
  writeJson(RUN_FILE, { startedAt, today });

  const delivered = range('meesho.delivered');
  const intransit = range('meesho.intransit');
  const msPay = range('meesho.payments', 30);
  const closed = range('flipkart.returnsClosed');
  const created = range('flipkart.returnsCreated');
  const cancelled = range('flipkart.cancellations');
  const fkPay = range('flipkart.payments', 30);

  // Every Supplier Panel address carries the account's own short code.
  const slug = process.env.MEESHO_PANEL_SLUG;
  if ((delivered || intransit || msPay) && !slug) {
    throw new Error('Set MEESHO_PANEL_SLUG in .env: the code after /fulfillment/ or /payouts/ in your Supplier Panel addresses.');
  }
  const panel = 'https://supplier.meesho.com/panel/v3/new';

  const meeshoPaid = msPay
    ? db.prepare("SELECT DISTINCT payment_date d FROM settlement_lines WHERE platform = 'meesho' AND payment_date >= ? ORDER BY d").all(addDays(msPay.from, -3)).map((r) => r.d)
    : [];
  const flipkartNefts = fkPay
    ? db.prepare("SELECT DISTINCT settlement_ref r FROM settlement_lines WHERE platform IN ('flipkart', 'shopsy') AND settlement_ref IS NOT NULL AND payment_date >= ?").all(addDays(fkPay.from, -7)).map((r) => r.r)
    : [];

  return {
    today,
    startedAt,
    downloadsFolder: DOWNLOADS,
    meesho: {
      delivered: delivered && {
        ...delivered,
        url: `${panel}/fulfillment/${slug}/returns/returnTracking-completed_delivered`,
        // "Delivered in last 2 weeks" covers a gap of up to 14 days with no change of filter.
        filter: 'Delivered in last 2 weeks',
        coveredByDefaultFilter: delivered.days <= 13,
      },
      intransit: intransit && {
        ...intransit,
        url: `${panel}/fulfillment/${slug}/returns/returnTracking-intransit`,
        filter: createdFilter(intransit.days),
      },
      payments: msPay && {
        ...msPay,
        alreadyImportedPaymentDates: meeshoPaid,
        paymentsUrl: `${panel}/payouts/${slug}/payments`,
        listUrl: `${panel}/payouts/${slug}/payments/previous-payments`,
        detailsUrl: `${panel}/payouts/${slug}/payments/payment-details/2/<YYYY-MM-DD>`,
      },
    },
    flipkart: {
      returnsClosed: closed && { ...closed, dates: eachDay(closed.from, closed.to) },
      returnsCreated: created,
      cancellations: cancelled,
      payments: fkPay && {
        ...fkPay,
        alreadyImportedNeftIds: flipkartNefts,
        listUrl: 'https://seller.flipkart.com/index.html#dashboard/payments/previous-payments?query=' +
          encodeURIComponent(JSON.stringify({ start_date: fkPay.from, end_date: today, token: '0', page_size: '8' })),
      },
    },
    nothingToDo: ![delivered, intransit, msPay, closed, created, cancelled, fkPay].some(Boolean),
  };
}

function createdFilter(days) {
  if (days <= 1) return 'Yesterday';
  if (days <= 3) return 'Last 3 days';
  if (days <= 7) return 'Last 1 week';
  if (days <= 14) return 'Last 2 weeks';
  if (days <= 30) return 'Last 1 month';
  return 'Custom date range';
}

// ─── import ────────────────────────────────────────────────────────────────────

/**
 * Bring tonight's downloads into the app with the same checks as the Import page.
 *
 * A file with nothing to decide is committed. A file with rows set aside or changed
 * amounts stays staged; the Import page shows it under "Waiting for your decision".
 * New SKU codes don't hold a file back: their lines show "cost missing" until priced,
 * as they do after a manual upload.
 */
async function importDownloads(paths) {
  const run = readJson(RUN_FILE, null);
  const files = paths.length ? paths.map((p) => path.resolve(p)) : findDownloads(run);
  if (!files.length) return { ok: true, files: [], note: `No marketplace downloads found in ${DOWNLOADS} since ${run?.startedAt || 'the plan'}.` };

  // Keep each night's files with the data, out of Downloads.
  const keepDir = path.join(DATA_DIR, 'fetch', localToday());
  fs.mkdirSync(keepDir, { recursive: true });
  const kept = files.map((f) => moveInto(f, keepDir, !paths.length));

  const db = openChecked();
  const alertsBefore = new Set(highAlerts(db).map((a) => a.key));
  const results = await stageFiles(db, kept.map((f) => ({ fileName: path.basename(f), buffer: fs.readFileSync(f) })));

  const clean = results.filter((r) => r.status === 'staged' && !r.summary.rejected && !r.summary.money_changed);
  const committed = clean.length ? await commitImports(db, clean.map((r) => r.importId)) : [];
  const fresh = highAlerts(db).filter((a) => !alertsBefore.has(a.key));

  const newCodes = {};
  for (const r of results) for (const [code, n] of Object.entries(r.summary?.unknownCodes || {})) newCodes[code] = (newCodes[code] || 0) + n;
  const review = results.filter((r) => r.status === 'staged' && !clean.includes(r));
  const failed = results.filter((r) => r.status === 'failed');

  return {
    ok: !review.length && !failed.length,
    keptIn: keepDir,
    files: results.map((r) => ({
      file: r.fileName,
      result: r.status === 'staged' ? (clean.includes(r) ? 'committed' : 'waiting for review') : r.status,
      ...(r.summary && {
        report: r.summary.label, new: r.summary.new, updated: r.summary.update, alreadyKnown: r.summary.unchanged,
        setAside: r.summary.rejected, moneyChanged: r.summary.money_changed, ...(r.summary.skipped ? { skipped: r.summary.skipped } : {}),
        datesFrom: r.summary.dateFrom, datesTo: r.summary.dateTo,
      }),
      ...(r.error && { error: r.error }),
    })),
    committedRows: committed.reduce((a, c) => a + c.inserted + c.updated, 0),
    waitingForReview: review.map((r) => r.fileName),
    failed: failed.map((r) => ({ file: r.fileName, error: r.error })),
    newSkuCodes: newCodes,
    // High-severity alerts that tonight's files raised (Alerts page), for the WhatsApp message.
    newAlerts: {
      count: fresh.length,
      byType: fresh.reduce((m, a) => ({ ...m, [a.label]: (m[a.label] || 0) + 1 }), {}),
      top: fresh.slice(0, 3).map((a) => `${a.label}: ${a.title}`),
    },
  };
}

/** High-severity alerts not marked OK. Keys are stable, so before/after shows what is new. */
function highAlerts(db) {
  return findAnomalies(db, {}).items.filter((a) => a.severity === 'high');
}

function findDownloads(run) {
  if (!run) throw new Error('Run "plan" first: it marks when tonight\'s downloads started.');
  const since = Date.parse(run.startedAt) - 60_000;
  return fs.readdirSync(DOWNLOADS)
    .filter((name) => DOWNLOAD_NAMES.some((re) => re.test(name)))
    .map((name) => path.join(DOWNLOADS, name))
    .filter((f) => fs.statSync(f).mtimeMs >= since)
    .sort();
}

/** Copy into the night's folder; the Downloads copy is removed once the copy is complete. */
function moveInto(file, dir, removeOriginal) {
  let dest = path.join(dir, path.basename(file));
  for (let i = 2; fs.existsSync(dest); i++) {
    const { name, ext } = path.parse(file);
    dest = path.join(dir, `${name} (${i})${ext}`);
  }
  fs.copyFileSync(file, dest);
  if (removeOriginal && fs.statSync(dest).size === fs.statSync(file).size) fs.unlinkSync(file);
  return dest;
}

// ─── mark ──────────────────────────────────────────────────────────────────────

function mark(step, date) {
  if (!STEPS.includes(step)) throw new Error(`Unknown step "${step}". Steps: ${STEPS.join(', ')}.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Give the date as YYYY-MM-DD.');
  if (date >= localToday()) throw new Error(`${date} is not over yet; mark only days up to yesterday.`);
  const state = readJson(STATE_FILE, {});
  // Never move a step backwards: a re-run of an older night must not re-open days.
  if (state[step] && state[step] >= date) return { ok: true, step, doneThrough: state[step], unchanged: true };
  state[step] = date;
  writeJson(STATE_FILE, state);
  return { ok: true, step, doneThrough: date };
}

// ─── helpers ───────────────────────────────────────────────────────────────────

function openChecked() {
  const db = getDb();
  const check = integrityCheck(db);
  if (!check.ok) throw new Error('Database integrity check failed. Restore the latest backup (Settings → Backups) before importing.');
  syncCatalog(db);
  return db;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write to a temporary file and rename, so a crash never leaves half a state file. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return localToday(new Date(y, m - 1, d + n));
}

function daysBetween(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((new Date(yb, mb - 1, db) - new Date(ya, ma - 1, da)) / 86_400_000);
}

function eachDay(from, to) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}
