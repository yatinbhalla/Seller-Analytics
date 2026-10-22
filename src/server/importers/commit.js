import { backup } from '../db/db.js';
import { contentHash, moneyOf } from './keys.js';
import { ENTITIES, getRow, insertRow, mergeOrder, mergeReturn, pick, removeRow, updateRow } from './entities.js';
import { compare } from './stage.js';

/**
 * Commit staged imports — all of them or none.
 *
 * 1. The database is backed up first.
 * 2. Inside ONE transaction, each staged row is compared again with the live database
 *    (another import may have landed since the preview) and written. Every write
 *    records the row as it was before, in row_versions, for undo.
 * 3. Before the transaction closes, reconcile() re-reads every row that was written
 *    and checks it against what was staged — content and money, to the paisa. Any
 *    mismatch throws, and SQLite rolls the whole batch back.
 *
 * Money changes the seller did not accept are left as they are in the database.
 */
export async function commitImports(db, importIds) {
  const ids = [...new Set(importIds.map(Number))];
  for (const id of ids) {
    const imp = db.prepare('SELECT status FROM imports WHERE id = ?').get(id);
    if (!imp) throw new Error(`No import #${id}.`);
    if (imp.status !== 'staged') throw new Error(`Import #${id} is ${imp.status}; only staged imports can be committed.`);
  }
  await backup(db, 'before-commit');

  const results = [];
  db.transaction(() => {
    for (const id of ids) results.push(commitOne(db, id));
  })();
  return results;
}

function commitOne(db, importId) {
  const staged = db.prepare('SELECT * FROM staged_rows WHERE import_id = ? ORDER BY rowid').all(importId);
  const addVersion = db.prepare(`INSERT INTO row_versions (import_id, entity, natural_key, action, before_json, after_json)
                                 VALUES (?, ?, ?, ?, ?, ?)`);
  const tally = { inserted: 0, updated: 0, unchanged: 0, moneySkipped: 0 };
  const expected = [];

  for (const s of staged) {
    const entity = s.entity;
    let payload = JSON.parse(s.payload);
    const existing = getRow(db, entity, s.natural_key);
    if (entity === 'return' && existing) payload = mergeReturn(existing, payload);
    if (entity === 'order' && existing) payload = mergeOrder(existing, payload);
    payload = pick(entity, payload);

    const { action } = compare(db, entity, s.natural_key, payload);
    if (action === 'unchanged') {
      tally.unchanged++;
      continue;
    }
    if (action === 'money_changed' && !s.accepted) {
      tally.moneySkipped++;
      continue;
    }

    const row = { ...payload, natural_key: s.natural_key, import_id: importId, source_ref: s.row_no, content_hash: contentHash(payload) };
    if (!existing) {
      insertRow(db, entity, row);
      addVersion.run(importId, entity, s.natural_key, 'insert', null, JSON.stringify(row));
      tally.inserted++;
    } else {
      updateRow(db, entity, row);
      addVersion.run(importId, entity, s.natural_key, 'update', JSON.stringify(existing), JSON.stringify(row));
      tally.updated++;
    }
    expected.push({ entity, key: s.natural_key, hash: row.content_hash, money: moneyOf(entity, payload) });
  }

  reconcile(db, importId, staged.length, tally, expected);

  db.prepare(`UPDATE imports SET status = 'committed', committed_at = datetime('now'),
              rows_new = ?, rows_updated = ?, rows_unchanged = ? WHERE id = ?`).run(tally.inserted, tally.updated, tally.unchanged, importId);
  db.prepare('DELETE FROM staged_rows WHERE import_id = ?').run(importId);
  return { importId, ...tally };
}

/**
 * The commit's own audit. Throws — which rolls the batch back — if:
 *   - any staged row is unaccounted for
 *   - any written row reads back different from what was staged
 *   - the money written for this import differs from the money staged, by even a paisa
 */
function reconcile(db, importId, stagedCount, tally, expected) {
  const accounted = tally.inserted + tally.updated + tally.unchanged + tally.moneySkipped;
  if (accounted !== stagedCount) {
    throw new Error(`Import #${importId}: ${stagedCount} rows staged but ${accounted} accounted for. Nothing was committed.`);
  }
  let moneyExpected = 0;
  let moneyFound = 0;
  for (const e of expected) {
    const row = getRow(db, e.entity, e.key);
    if (!row || row.content_hash !== e.hash || row.import_id !== importId) {
      throw new Error(`Import #${importId}: row ${e.key} did not read back as written. Nothing was committed.`);
    }
    moneyExpected += e.money;
    moneyFound += moneyOf(e.entity, row);
  }
  if (moneyExpected !== moneyFound) {
    throw new Error(`Import #${importId}: ₹${moneyExpected / 100} staged but ₹${moneyFound / 100} written. Nothing was committed.`);
  }
}

/**
 * Undo a committed import: remove the rows it added and put back the rows it changed.
 *
 * Refused if a LATER import changed any of the same rows — undoing this one first
 * would throw that later import's work away. Undo those first, newest first.
 */
export async function revertImport(db, importId) {
  const imp = db.prepare('SELECT status FROM imports WHERE id = ?').get(importId);
  if (!imp) throw new Error(`No import #${importId}.`);
  if (imp.status !== 'committed') throw new Error(`Import #${importId} is ${imp.status}; only committed imports can be undone.`);

  const blockers = db
    .prepare(`SELECT DISTINCT later.import_id AS id FROM row_versions mine
              JOIN row_versions later ON later.entity = mine.entity AND later.natural_key = mine.natural_key AND later.id > mine.id
              JOIN imports i ON i.id = later.import_id AND i.status = 'committed'
              WHERE mine.import_id = ? AND later.import_id <> ?`)
    .all(importId, importId)
    .map((r) => r.id);
  if (blockers.length) {
    throw new Error(`Import(s) #${blockers.join(', #')} changed rows this import wrote. Undo them first.`);
  }

  await backup(db, `before-undo-${importId}`);
  db.transaction(() => {
    const versions = db.prepare('SELECT * FROM row_versions WHERE import_id = ? ORDER BY id DESC').all(importId);
    for (const v of versions) {
      if (v.action === 'insert') {
        removeRow(db, v.entity, v.natural_key);
      } else {
        const before = JSON.parse(v.before_json);
        const cols = ['natural_key', ...ENTITIES[v.entity].columns, 'import_id', 'source_ref', 'content_hash'];
        const restored = Object.fromEntries(cols.map((c) => [c, before[c] ?? null]));
        updateRow(db, v.entity, restored);
      }
    }
    db.prepare("UPDATE imports SET status = 'reverted', reverted_at = datetime('now') WHERE id = ?").run(importId);
  })();
  return { importId, rowsRestored: db.prepare('SELECT COUNT(*) n FROM row_versions WHERE import_id = ?').get(importId).n };
}
