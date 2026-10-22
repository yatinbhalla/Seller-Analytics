import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(process.env.ANALYTICS_DATA_DIR || 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_BACKUPS = 30;

/** Defaults written once; the seller changes them in Settings afterwards. */
export const DEFAULT_SETTINGS = {
  // ₹7 per shipped packet — material, tape, label. Charged on returns and RTO too,
  // because the packet was made either way.
  packaging_paise: '700',
  // A closed, received return with no condition in the file is treated as resellable.
  // The seller can mark any one damaged, which keeps it out of stock.
  default_return_condition: 'good',
  // 'ignore' (the seller's choice, 2026-10-22): GST collected on sales is offset by the
  // input credit claimed on purchases, so profit is shown before GST and costs are
  // taken as given. 'deduct_output' takes each kept sale's GST off profit instead.
  gst_mode: 'ignore',
  // GST rate assumed for an order known only from a payment or returns file, when
  // neither the file nor any invoice of the same code says. Most of the catalogue
  // (textiles under ₹1,000) is 5%.
  default_gst_pct: '5',
  stale_return_days: '30',
  // Marketplaces pay an order 7–15 days after dispatch (the seller's experience, and
  // what the real payment files show: almost all on days 10–15). Unsettled orders are
  // expected inside this window and flagged as overdue after it.
  payment_days_min: '7',
  payment_days_max: '15',
  estimate_window_days: '60',
};

let _db = null;

/**
 * Open (or create) the database and bring the schema up to date.
 *
 * WAL + synchronous=FULL: a commit is on disk before the call returns, and a crash
 * mid-write leaves the last committed state intact. foreign_keys is off by default in
 * SQLite and has to be switched on per connection.
 */
export function openDb(file = path.join(DATA_DIR, 'analytics.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));
  migrate(db);
  db.exec(fs.readFileSync(path.join(HERE, 'views.sql'), 'utf8'));

  const put = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) put.run(k, v);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
  return db;
}

/**
 * Columns added after a database was first created. CREATE TABLE IF NOT EXISTS
 * leaves an existing table as it was, so each one is added here if it is missing.
 * Adding a nullable column never touches existing rows.
 */
const ADDED_COLUMNS = {
  settlement_lines: {
    order_date: 'TEXT', dispatch_date: 'TEXT', qty: 'INTEGER', gst_pct: 'REAL', invoice_no: 'TEXT', invoice_date: 'TEXT',
    tcs_paise: 'INTEGER', tds_paise: 'INTEGER',
  },
  returns: { dispatch_date: 'TEXT', price_paise: 'INTEGER', invoice_no: 'TEXT', invoice_date: 'TEXT' },
};

function migrate(db) {
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, type] of Object.entries(cols)) {
      if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  }
}

export function getDb() {
  if (!_db) _db = openDb();
  return _db;
}

/** Tests swap in an in-memory database. */
export function setDb(db) {
  _db = db;
}

export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

/**
 * Full integrity check. A corrupt page shows up here before it shows up as a wrong
 * number on the dashboard.
 */
export function integrityCheck(db) {
  const rows = db.pragma('integrity_check');
  const fk = db.pragma('foreign_key_check');
  const ok = rows.length === 1 && rows[0].integrity_check === 'ok' && fk.length === 0;
  return { ok, integrity: rows.map((r) => r.integrity_check), foreignKeyProblems: fk.length };
}

/**
 * Copy the live database to data/backups/ and keep the newest 30.
 *
 * Uses SQLite's online backup, which is consistent even while the app is writing —
 * a plain file copy of a WAL database can capture half a transaction.
 */
export async function backup(db, label = 'auto') {
  if (db.name === ':memory:') return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `analytics-${stamp}-${label}.db`);
  await db.backup(dest);
  pruneBackups();
  return dest;
}

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, bytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pruneBackups() {
  for (const old of listBackups().slice(KEEP_BACKUPS)) {
    fs.rmSync(path.join(BACKUP_DIR, old.file), { force: true });
  }
}

/**
 * Replace the live database with a backup. The current one is backed up first, so a
 * restore can itself be undone.
 */
export async function restoreBackup(file) {
  const src = path.join(BACKUP_DIR, path.basename(file));
  if (!fs.existsSync(src)) throw new Error(`No backup named ${file}.`);
  const probe = new Database(src, { readonly: true });
  const check = integrityCheck(probe);
  probe.close();
  if (!check.ok) throw new Error(`Backup ${file} fails its integrity check; not restoring it.`);

  const live = getDb();
  await backup(live, 'before-restore');
  const livePath = live.name;
  live.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(livePath + suffix, { force: true });
  fs.copyFileSync(src, livePath);
  _db = openDb(livePath);
  return _db;
}
