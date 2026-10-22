import { describe, expect, it } from 'vitest';
import {
  csv, FK_RET_HEAD, FK_SETTLE_HEAD, makeDb, MEESHO_PAY_HEAD, MEESHO_RET_HEAD, meeshoPayRow, xlsx,
} from './helpers.js';
import { stageFiles, setAccepted } from '../src/server/importers/stage.js';
import { commitImports, revertImport } from '../src/server/importers/commit.js';

async function importAll(db, files) {
  const staged = await stageFiles(db, files);
  const ids = staged.filter((s) => s.status === 'staged').map((s) => s.importId);
  if (ids.length) await commitImports(db, ids);
  return staged;
}

const snapshot = (db) => ({
  orders: db.prepare('SELECT natural_key, content_hash FROM orders ORDER BY natural_key').all(),
  returns: db.prepare('SELECT natural_key, status, outcome, reason, closed_date FROM returns ORDER BY natural_key').all(),
  settlement: db.prepare('SELECT natural_key, net_paise FROM settlement_lines ORDER BY natural_key').all(),
});

const pay = (rows) => xlsx({ 'Order Payments': [['Order Related Details', '', 'Payment Details'], MEESHO_PAY_HEAD, ...rows.map(meeshoPayRow)] });

const DAY1 = [
  ['1001_1', 'WH_MFO/40365', 'Delivered', 289, 0, -40.5, -60, 0, -2.45, -2.89],
  ['1002_1', 'WH_4MFO/11111', 'Delivered', 429, 0, -55, -70, 0, -3.64, -4.29],
];
const DAY2 = [
  DAY1[1],
  ['1003_1', 'TC_BT/1.1', 'Delivered', 379, 0, -50, -65, 0, -3.21, -3.79],
];

describe('Meesho payment file', () => {
  it('stages with the header found below a title row, and commits exactly', async () => {
    const db = makeDb();
    const [res] = await stageFiles(db, [{ buffer: pay(DAY1), fileName: 'payments.xlsx' }]);
    expect(res.status).toBe('staged');
    expect(res.summary.kind).toBe('meesho.payments');
    expect(res.summary.new).toBe(2);
    expect(db.prepare('SELECT COUNT(*) n FROM settlement_lines').get().n).toBe(0); // nothing visible before commit

    await commitImports(db, [res.importId]);
    const lines = db.prepare('SELECT * FROM settlement_lines ORDER BY order_item_key').all();
    expect(lines).toHaveLength(2);
    expect(lines[0].net_paise).toBe(18316); // 289 − 40.5 − 60 − 2.45 − 2.89
    // The parts always add up to the payout.
    for (const l of lines) {
      const parts = l.sale_paise + l.refund_paise + l.commission_paise + l.fixed_fee_paise + l.shipping_paise + l.reverse_ship_paise +
        l.collection_paise + l.tax_withheld_paise + l.penalty_paise + l.claim_paise + l.ads_paise + l.other_paise;
      expect(parts).toBe(l.net_paise);
    }
  });

  it('refuses the same file twice', async () => {
    const db = makeDb();
    await importAll(db, [{ buffer: pay(DAY1), fileName: 'payments.xlsx' }]);
    const [again] = await stageFiles(db, [{ buffer: pay(DAY1), fileName: 'payments (1).xlsx' }]);
    expect(again.status).toBe('already_imported');
  });

  it('day 1 then day 2 (overlapping) equals importing their union, and re-imports change nothing', async () => {
    const a = makeDb();
    await importAll(a, [{ buffer: pay(DAY1), fileName: 'd1.xlsx' }]);
    const [d2] = await importAll(a, [{ buffer: pay(DAY2), fileName: 'd2.xlsx' }]);
    expect(d2.summary.unchanged).toBe(1);
    expect(d2.summary.new).toBe(1);

    const b = makeDb();
    await importAll(b, [{ buffer: pay([...DAY1, DAY2[1]]), fileName: 'union.xlsx' }]);
    expect(snapshot(a)).toEqual(snapshot(b));

    const before = snapshot(a);
    await importAll(a, [{ buffer: pay([DAY1[0]]), fileName: 'subset.xlsx' }]);
    expect(snapshot(a)).toEqual(before);
  });

  it('collapses the same row twice in one upload', async () => {
    const db = makeDb();
    const [res] = await importAll(db, [{ buffer: pay([DAY1[0], DAY1[0], DAY1[1]]), fileName: 'dupe.xlsx' }]);
    expect(res.summary.batchDupes).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM settlement_lines').get().n).toBe(2);
  });

  it('flags a changed amount and only applies it when accepted', async () => {
    const db = makeDb();
    await importAll(db, [{ buffer: pay([DAY1[0]]), fileName: 'd1.xlsx' }]);
    const changed = [...DAY1[0]];
    changed[5] = -45.5; // commission corrected by Meesho
    const [res] = await stageFiles(db, [{ buffer: pay([changed]), fileName: 'd1-revised.xlsx' }]);
    expect(res.summary.money_changed).toBe(1);

    await commitImports(db, [res.importId]); // not accepted → untouched
    expect(db.prepare('SELECT net_paise FROM settlement_lines').get().net_paise).toBe(18316);

    const [res2] = await stageFiles(db, [{ buffer: pay([changed, DAY1[1]]), fileName: 'd1-revised-2.xlsx' }]);
    const key = db.prepare("SELECT natural_key FROM staged_rows WHERE import_id = ? AND action = 'money_changed'").get(res2.importId).natural_key;
    setAccepted(db, res2.importId, 'settlement', key, true);
    await commitImports(db, [res2.importId]);
    expect(db.prepare("SELECT net_paise FROM settlement_lines WHERE order_item_key = '1001_1'").get().net_paise).toBe(17816);
  });

  it('quarantines a row whose ID Excel turned into scientific notation', async () => {
    const db = makeDb();
    const bad = meeshoPayRow(DAY1[0]);
    bad[0] = '1.15993E+17';
    const buffer = xlsx({ Sheet1: [MEESHO_PAY_HEAD, bad, meeshoPayRow(DAY1[1])] });
    const [res] = await importAll(db, [{ buffer, fileName: 'p.xlsx' }]);
    expect(res.summary.rejected).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM settlement_lines').get().n).toBe(1);
    expect(db.prepare('SELECT reason FROM import_rows_rejected').get().reason).toMatch(/scientific notation/);
  });

  it('refuses a file with a renamed required column, naming it', async () => {
    const db = makeDb();
    const head = MEESHO_PAY_HEAD.map((h) => (h === 'Final Settlement Amount' ? 'Net Amount Paid' : h));
    const [res] = await stageFiles(db, [{ buffer: xlsx({ S: [head, meeshoPayRow(DAY1[0])] }), fileName: 'p.xlsx' }]);
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/missing column.*Final Settlement Amount/);
  });

  it('refuses a truncated file', async () => {
    const db = makeDb();
    const full = pay(DAY1);
    const [res] = await stageFiles(db, [{ buffer: full.subarray(0, Math.floor(full.length / 2)), fileName: 'cut.xlsx' }]);
    expect(res.status).toBe('failed');
  });

  it('undoes an import, and refuses to undo one a later import built on', async () => {
    const db = makeDb();
    const [first] = await importAll(db, [{ buffer: pay(DAY1), fileName: 'd1.xlsx' }]);
    const changed = [...DAY1[0]];
    changed[5] = -45.5;
    const [second] = await stageFiles(db, [{ buffer: pay([changed]), fileName: 'd1b.xlsx' }]);
    const key = db.prepare("SELECT natural_key FROM staged_rows WHERE import_id = ?").get(second.importId).natural_key;
    setAccepted(db, second.importId, 'settlement', key, true);
    await commitImports(db, [second.importId]);

    await expect(revertImport(db, first.importId)).rejects.toThrow(/Undo them first/);
    await revertImport(db, second.importId);
    expect(db.prepare("SELECT net_paise FROM settlement_lines WHERE order_item_key = '1001_1'").get().net_paise).toBe(18316);
    await revertImport(db, first.importId);
    expect(db.prepare('SELECT COUNT(*) n FROM settlement_lines').get().n).toBe(0);
  });
});

describe('returns: created then closure', () => {
  const created = csv([
    MEESHO_RET_HEAD,
    ['Organizer', 'WH_MFO/40365', '1', '1001', '1001_1', '2026-10-08', 'Customer Return', '', 'In Transit', 'Size issue', 'Smaller than expected', ''],
    ['Cover', 'TC_BT/1.1', '1', '1003', '1003_1', '2026-10-09', 'Courier Return (RTO)', 'RTO', 'In Transit', '', '', ''],
  ]);
  const closure = csv([
    MEESHO_RET_HEAD,
    ['Organizer', 'WH_MFO/40365', '1', '1001', '1001_1', '', 'Customer Return', '', 'Delivered', '', '', '2026-10-14'],
  ]);

  it('merges into one closed return that keeps its reason', async () => {
    const db = makeDb();
    await importAll(db, [{ buffer: created, fileName: 'returns-created.csv' }]);
    expect(db.prepare("SELECT COUNT(*) n FROM returns WHERE status = 'open'").get().n).toBe(2);
    await importAll(db, [{ buffer: closure, fileName: 'returns-closed.csv' }]);
    const r = db.prepare("SELECT * FROM returns WHERE order_item_key = '1001_1'").get();
    expect(r).toMatchObject({ status: 'closed', outcome: 'received', reason: 'Size issue', closed_date: '2026-10-14', created_date: '2026-10-08' });
    expect(db.prepare('SELECT COUNT(*) n FROM returns').get().n).toBe(2);
    expect(db.prepare("SELECT return_type FROM returns WHERE order_item_key = '1003_1'").get().return_type).toBe('rto');
  });

  it('does not reopen a closed return when an old created file comes in again', async () => {
    const db = makeDb();
    await importAll(db, [{ buffer: closure, fileName: 'closed.csv' }]);
    await importAll(db, [{ buffer: created, fileName: 'created.csv' }]);
    const r = db.prepare("SELECT * FROM returns WHERE order_item_key = '1001_1'").get();
    expect(r.status).toBe('closed');
    expect(r.reason).toBe('Size issue');
  });

  it('merges created and closure uploaded together in one batch', async () => {
    const db = makeDb();
    await importAll(db, [{ buffer: created, fileName: 'c.csv' }, { buffer: closure, fileName: 'd.csv' }]);
    const r = db.prepare("SELECT * FROM returns WHERE order_item_key = '1001_1'").get();
    expect(r).toMatchObject({ status: 'closed', reason: 'Size issue' });
  });
});

describe('Flipkart files', () => {
  it('reads the settlement report with Shopsy rows and the returns report', async () => {
    const db = makeDb();
    const settle = xlsx({
      Orders: [
        FK_SETTLE_HEAD,
        ['NEFT1', '2026-10-12', 300.5, 'OD033333333333333330', 'OI1', 379, 0, -50, -15, -60, 0, -3.21, -3.79, 'TC_BT/72151', 1, 'No'],
        ['NEFT1', '2026-10-12', 180, 'OD033333333333333337', 'OI2', 289, 0, -40, -12, -55, 0, -2, 0, 'WH_MFO/40365', 1, 'Yes'],
      ],
    });
    const returns = xlsx({
      Returns: [
        FK_RET_HEAD,
        ['OD033333333333333330', 'OI1', 'R1', 'customer_return', 'completed', 'Not as described', 'Colour', 'Looks different', 'TC_BT/72151', 1, '2026-10-13', '2026-10-18'],
      ],
    });
    const res = await importAll(db, [{ buffer: settle, fileName: 's.xlsx' }, { buffer: returns, fileName: 'r.xlsx' }]);
    expect(res.map((r) => r.summary.kind)).toEqual(['flipkart.settlement', 'flipkart.returns']);
    const lines = db.prepare('SELECT platform, net_paise, other_paise FROM settlement_lines ORDER BY order_id').all();
    expect(lines).toEqual([
      { platform: 'flipkart', net_paise: 30050, other_paise: 30050 - (37900 - 5000 - 1500 - 6000 - 321 - 379) },
      { platform: 'shopsy', net_paise: 18000, other_paise: 18000 - (28900 - 4000 - 1200 - 5500 - 200) },
    ]);
    expect(db.prepare('SELECT order_item_key, status, outcome FROM returns').get()).toEqual({
      order_item_key: 'OD033333333333333330:TC_BT/72151', status: 'closed', outcome: 'received',
    });
  });
});
