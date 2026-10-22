import fs from 'fs';
import { unzipSync } from 'fflate';
import path from 'path';
import { DATA_DIR } from '../db/db.js';
import { resolveCode } from '../catalog/sku.js';
import { detectFile } from './registry.js';
import { contentHash, MONEY_FIELDS, moneyOf, naturalKey, sha256 } from './keys.js';
import { getRow, isOrderReport, mergeOrder, mergeReturn, pick } from './entities.js';

const ACCOUNT = 'main';

/**
 * Stage a batch of uploaded files: read, check and compare them, write NOTHING the
 * dashboard can see.
 *
 * Every file gets an `imports` row and its parsed rows go to `staged_rows`, each
 * marked new / update / unchanged / money_changed against what the database already
 * holds. The seller sees that preview and decides; commit.js does the writing.
 *
 * Duplicates are caught at three levels:
 *   1. the same file (same bytes) → "already imported", not staged at all
 *   2. the same row twice in this batch (Monday's and Tuesday's download both carry
 *      an order) → collapsed to one, or merged for returns
 *   3. the same row already in the database → unchanged, and skipped at commit
 */
export async function stageFiles(db, uploaded) {
  const results = [];
  const batchRows = new Map(); // entity|natural_key → { importId, contentHash }
  const batchShas = new Map();
  const files = [];
  for (const f of uploaded) {
    try {
      files.push(...expandZip(f));
    } catch (err) {
      results.push({ fileName: f.fileName, status: 'failed', error: err.message });
    }
  }

  for (const file of files) {
    const sha = sha256(file.buffer);
    const already = db.prepare("SELECT id, committed_at FROM imports WHERE sha256 = ? AND status = 'committed'").get(sha);
    if (already) {
      results.push({ fileName: file.fileName, status: 'already_imported', importId: already.id, committedAt: already.committed_at });
      continue;
    }
    if (batchShas.has(sha)) {
      results.push({ fileName: file.fileName, status: 'duplicate_in_batch', sameAs: batchShas.get(sha) });
      continue;
    }
    batchShas.set(sha, file.fileName);
    const storedPath = storeOriginal(file.buffer, sha, file.fileName);

    let found;
    try {
      found = await detectFile(file.buffer, file.fileName);
    } catch (err) {
      const id = db
        .prepare("INSERT INTO imports (sha256, file_name, stored_path, status, error) VALUES (?, ?, ?, 'failed', ?)")
        .run(sha, file.fileName, storedPath, err.message).lastInsertRowid;
      results.push({ fileName: file.fileName, status: 'failed', importId: id, error: err.message });
      continue;
    }

    const { importer, detected, input } = found;
    const parsed = importer.parse(input, detected, { db });
    const importId = db
      .prepare("INSERT INTO imports (sha256, file_name, stored_path, kind, platform, status) VALUES (?, ?, ?, ?, ?, 'staged')")
      .run(sha, file.fileName, storedPath, importer.kind, importer.platform).lastInsertRowid;

    const summary = stageRows(db, importId, parsed, batchRows);
    summary.kind = importer.kind;
    summary.label = importer.label;
    // Rows an importer leaves out on purpose, shown only where it says why.
    if (importer.skipLabel) Object.assign(summary, { skipped: parsed.skipped || 0, skipLabel: importer.skipLabel });
    if (input.pages) summary.pages = input.pages.length;

    db.prepare(`UPDATE imports SET rows_total = ?, rows_new = ?, rows_updated = ?, rows_unchanged = ?, rows_rejected = ?,
                rows_money_changed = ?, rows_batch_dupes = ?, money_total_paise = ?, date_from = ?, date_to = ?, summary_json = ?
                WHERE id = ?`).run(
      summary.parsed, summary.new, summary.update, summary.unchanged, summary.rejected, summary.money_changed,
      summary.batchDupes, summary.moneyTotal, summary.dateFrom, summary.dateTo, JSON.stringify(summary), importId,
    );
    results.push({ fileName: file.fileName, status: 'staged', importId, summary });
  }
  return results;
}

function stageRows(db, importId, parsed, batchRows) {
  const insertStaged = db.prepare(`INSERT INTO staged_rows (import_id, row_no, entity, natural_key, payload, action, diff, accepted)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateStaged = db.prepare('UPDATE staged_rows SET payload = ?, action = ?, diff = ? WHERE import_id = ? AND entity = ? AND natural_key = ?');
  const reject = db.prepare('INSERT INTO import_rows_rejected (import_id, row_no, reason, raw) VALUES (?, ?, ?, ?)');

  const s = {
    parsed: parsed.rows.length + parsed.rejected.length,
    new: 0, update: 0, unchanged: 0, money_changed: 0, rejected: parsed.rejected.length, batchDupes: 0,
    moneyTotal: 0, parsedMoneyTotal: 0, dupeMoneyTotal: 0, dateFrom: null, dateTo: null,
    unknownCodes: {}, returnsOpen: 0, returnsClosed: 0, platforms: {}, invoicesFound: 0,
  };

  db.transaction(() => {
    for (const r of parsed.rejected) reject.run(importId, String(r.rowNo), r.reason, r.raw ? JSON.stringify(r.raw) : null);

    for (const row of parsed.rows) {
      const entity = row.entity;
      let payload = { ...pick(entity, { ...row.payload, account: ACCOUNT }) };
      const key = naturalKey(payload.platform, ACCOUNT, row.key);
      const money = moneyOf(entity, payload);
      s.parsedMoneyTotal += money;

      // Same row earlier in this batch.
      const seen = batchRows.get(`${entity}|${key}`);
      if (seen) {
        const prev = db.prepare('SELECT payload FROM staged_rows WHERE import_id = ? AND entity = ? AND natural_key = ?').get(seen.importId, entity, key);
        const prevPayload = JSON.parse(prev.payload);
        // An invoice and a cancellation of the same line merge, and so do an invoice and
        // an orders-report line; two different invoices for one line still fall through
        // to the conflict below.
        const orderMerge = entity === 'order'
          && (!!prevPayload.cancelled !== !!payload.cancelled || isOrderReport(prevPayload) !== isOrderReport(payload));
        if (entity === 'return' || orderMerge) {
          const merged = orderMerge ? mergeOrder(prevPayload, payload) : mergeReturn({ ...prevPayload, status: prevPayload.status }, payload);
          const { action, diff } = compare(db, entity, key, merged);
          updateStaged.run(JSON.stringify({ ...merged, content_hash: contentHash(merged) }), action, diff, seen.importId, entity, key);
          s.batchDupes++;
          s.dupeMoneyTotal += money;
          continue;
        }
        if (contentHash(prevPayload) === contentHash(payload)) {
          s.batchDupes++;
          s.dupeMoneyTotal += money;
          continue;
        }
        reject.run(importId, String(row.rowNo),
          `the same ${entity} (${row.key}) appears twice in this upload with different values — kept the first, check this one`,
          JSON.stringify(payload));
        s.rejected++;
        s.dupeMoneyTotal += money;
        continue;
      }

      if (entity === 'return') payload = mergeReturn(getRow(db, 'return', key), payload);
      if (entity === 'order') payload = mergeOrder(getRow(db, 'order', key), payload);
      const { action, diff } = compare(db, entity, key, payload);
      insertStaged.run(
        importId, String(row.rowNo), entity, key,
        JSON.stringify({ ...payload, content_hash: contentHash(payload) }),
        action, diff, action === 'money_changed' ? 0 : 1,
      );
      batchRows.set(`${entity}|${key}`, { importId });
      s[action]++;
      s.moneyTotal += money;
      s.platforms[payload.platform] = (s.platforms[payload.platform] || 0) + 1;
      if (entity === 'order') s.invoicesFound++;
      if (entity === 'return') payload.status === 'closed' ? s.returnsClosed++ : s.returnsOpen++;

      const d = payload.invoice_date || payload.order_date || payload.payment_date || payload.closed_date || payload.created_date;
      if (d) {
        if (!s.dateFrom || d < s.dateFrom) s.dateFrom = d;
        if (!s.dateTo || d > s.dateTo) s.dateTo = d;
      }
      if (payload.code && !resolveCode(db, payload.code)) {
        s.unknownCodes[payload.code] = (s.unknownCodes[payload.code] || 0) + 1;
      }
    }
  })();

  // Nothing parsed may vanish between the file and the preview.
  if (s.parsedMoneyTotal !== s.moneyTotal + s.dupeMoneyTotal) {
    throw new Error(`Internal check failed staging import #${importId}: money does not add up.`);
  }
  return s;
}

/** How a staged row differs from the database copy, if there is one. */
export function compare(db, entity, key, payload) {
  const existing = getRow(db, entity, key);
  if (!existing) return { action: 'new', diff: null };
  if (existing.content_hash === contentHash(payload)) return { action: 'unchanged', diff: null };
  const changed = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k in existing && existing[k] !== v) changed[k] = { from: existing[k], to: v };
  }
  // An invoice replacing an orders-report line is the real figure arriving, not a
  // change to confirm.
  const invoiceArrived = entity === 'order' && isOrderReport(existing) && !isOrderReport(payload);
  const moneyMoved = !invoiceArrived && MONEY_FIELDS[entity].some((f) => f in changed);
  return { action: moneyMoved ? 'money_changed' : 'update', diff: JSON.stringify(changed) };
}

const ZIP_INNER = /\.(xlsx|xls|csv|pdf)$/i;
const ZIP_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Meesho's payment download is a .zip with the Excel inside. A .zip becomes the
 * report files it holds, each staged as if uploaded on its own — so the same Excel
 * inside two different downloads is still caught as the same file.
 */
function expandZip(file) {
  if (!/\.zip$/i.test(file.fileName)) return [file];
  let total = 0;
  const entries = unzipSync(new Uint8Array(file.buffer), {
    filter: (f) => {
      if (!ZIP_INNER.test(f.name) || /(^|\/)(__MACOSX|\.)/.test(f.name)) return false;
      total += f.originalSize;
      if (total > ZIP_MAX_BYTES) throw new Error(`${file.fileName} unpacks to more than 100 MB — not a marketplace report.`);
      return true;
    },
  });
  const inner = Object.entries(entries).map(([name, data]) => ({ fileName: path.basename(name), buffer: Buffer.from(data), fromZip: file.fileName }));
  if (!inner.length) throw new Error(`${file.fileName} has no Excel, CSV or PDF inside.`);
  return inner;
}

/** Keep the uploaded file byte-for-byte, named by its hash, so any figure can be traced back to it. */
function storeOriginal(buffer, sha, fileName) {
  const month = new Date().toISOString().slice(0, 7);
  const ext = (path.extname(fileName) || '.bin').toLowerCase();
  const dir = path.join(DATA_DIR, 'imports', month);
  const dest = path.join(dir, `${sha}${ext}`);
  if (process.env.ANALYTICS_NO_FILE_STORE === '1') return dest;
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buffer);
  return dest;
}

/** Throw away a staged import the seller decided not to commit. */
export function discardImport(db, importId) {
  db.transaction(() => {
    const imp = db.prepare('SELECT status FROM imports WHERE id = ?').get(importId);
    if (!imp) throw new Error(`No import #${importId}.`);
    if (imp.status !== 'staged') throw new Error(`Import #${importId} is ${imp.status}, not staged.`);
    db.prepare('DELETE FROM staged_rows WHERE import_id = ?').run(importId);
    db.prepare("UPDATE imports SET status = 'discarded' WHERE id = ?").run(importId);
  })();
}

/** Accept or refuse one money change the preview flagged. */
export function setAccepted(db, importId, entity, key, accepted) {
  const r = db
    .prepare("UPDATE staged_rows SET accepted = ? WHERE import_id = ? AND entity = ? AND natural_key = ? AND action = 'money_changed'")
    .run(accepted ? 1 : 0, importId, entity, key);
  if (!r.changes) throw new Error('No such money change waiting for a decision.');
}
