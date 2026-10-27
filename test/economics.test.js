import { describe, expect, it } from 'vitest';
import { makeDb } from './helpers.js';
import { contentHash, naturalKey } from '../src/server/importers/keys.js';
import { overview, paymentsDue, pnl, products } from '../src/server/metrics/reports.js';
import { dataHealth } from '../src/server/metrics/health.js';
import { stockReport, addMove } from '../src/server/inventory/ledger.js';
import { setSetting } from '../src/server/db/db.js';

/** Insert rows straight into the tables, as a committed import would leave them. */
function seed(db, { orders = [], returns = [], settlements = [] }) {
  const imp = db.prepare("INSERT INTO imports (sha256, file_name, stored_path, status) VALUES ('x', 'seed', 'x', 'committed')").run().lastInsertRowid;
  for (const o of orders) {
    const row = {
      platform: 'meesho', account: 'main', order_id: o.key.split('_')[0], shipment_key: o.ship || o.key, invoice_no: null,
      invoice_date: o.date || '2026-10-05', order_date: null, sku: o.sku, code: o.sku.split('/')[0].toUpperCase(), qty: o.qty || 1,
      gross_paise: o.total, discount_paise: 0, taxable_paise: Math.round(o.total / 1.12), tax_paise: o.total - Math.round(o.total / 1.12),
      total_paise: o.total, ship_state: null, ship_pincode: null, cancelled: 0, ...o.extra, order_item_key: o.key,
    };
    db.prepare(`INSERT INTO orders (natural_key, ${Object.keys(row).join(', ')}, import_id, source_ref, content_hash)
                VALUES (@natural_key, ${Object.keys(row).map((k) => '@' + k).join(', ')}, @import_id, 'seed', @content_hash)`)
      .run({ ...row, natural_key: naturalKey(row.platform, 'main', o.key), import_id: imp, content_hash: contentHash(row) });
  }
  for (const r of returns) {
    db.prepare(`INSERT INTO returns (natural_key, platform, return_key, order_item_key, sku, code, qty, return_type, reason, created_date,
                closed_date, status, outcome, condition, import_id, content_hash)
                VALUES (?, 'meesho', ?, ?, ?, ?, 1, ?, ?, '2026-10-08', ?, ?, ?, ?, ?, 'h')`)
      .run(naturalKey('meesho', 'main', r.key), r.key, r.key, r.sku, r.sku.split('/')[0], r.type || 'customer', r.reason || 'Size issue',
        r.closed || null, r.closed ? 'closed' : 'open', r.outcome || (r.closed ? 'received' : null), r.condition || null, imp);
  }
  for (const s of settlements) {
    db.prepare(`INSERT INTO settlement_lines (natural_key, platform, order_item_key, txn_type, payment_date, sale_paise, commission_paise,
                tax_withheld_paise, net_paise, import_id, content_hash) VALUES (?, 'meesho', ?, ?, '2026-10-12', ?, ?, ?, ?, ?, 'h')`)
      .run(naturalKey('meesho', 'main', `${s.key}|${s.type || 'sale'}`), s.key, s.type || 'sale', s.sale || 0, s.commission || 0, s.tax || 0, s.net, imp);
  }
}

describe('profit and packaging', () => {
  it('charges ₹7 once per packet, whatever the pack size', () => {
    const db = makeDb();
    seed(db, {
      orders: [{ key: '1_1', sku: 'WH_4MFO/1', total: 42900 }],
      settlements: [{ key: '1_1', sale: 42900, commission: -12900, net: 30000 }],
    });
    const t = overview(db, {}).total;
    expect(t.packaging).toBe(700);
    // payout 300 − cost 240 (4-pack) − packaging 7. GST is off by default: the seller
    // offsets it with input credit on purchases.
    expect(t.profit).toBe(30000 - 24000 - 700);
  });

  it('shares one ₹7 between lines in the same packet', () => {
    const db = makeDb();
    seed(db, { orders: [{ key: '2_1', sku: 'WH_MFO/1', total: 20000, ship: 'P1' }, { key: '2_2', sku: 'TC_BT/1', total: 23000, ship: 'P1' }] });
    expect(overview(db, {}).total.packaging).toBe(700);
  });

  it('keeps the ₹7 on RTO and customer returns, and counts it in return cost', () => {
    const db = makeDb();
    seed(db, {
      orders: [{ key: '3_1', sku: 'WH_MFO/1', total: 20000 }, { key: '4_1', sku: 'WH_MFO/2', total: 20000 }],
      returns: [{ key: '3_1', sku: 'WH_MFO/1', type: 'rto', closed: '2026-10-12' }, { key: '4_1', sku: 'WH_MFO/2', type: 'customer', closed: '2026-10-14' }],
      settlements: [{ key: '3_1', type: 'return', net: 0 }, { key: '4_1', type: 'return', net: -6500 }],
    });
    const t = overview(db, {}).total;
    expect(t.packaging).toBe(1400);
    expect(t.packagingOnReturns).toBe(1400);
    // Both came back in good condition, so no COGS lost: cost = ₹7 + ₹7 + ₹65 reverse charges.
    expect(t.returnCost).toBe(700 + 700 + 6500);
    // The P&L comes from the payments: both return payments carry their packet.
    const steps = pnl(db, {}).total.steps;
    expect(steps.find((s) => s.label === 'Packets (₹7 each)').value).toBe(-1400);
  });

  it('charges COGS for a return that came back damaged or was lost, not for a restocked one', () => {
    const db = makeDb();
    seed(db, {
      orders: [{ key: '5_1', sku: 'WH_MFO/1', total: 20000 }, { key: '6_1', sku: 'WH_MFO/2', total: 20000 }],
      returns: [{ key: '5_1', sku: 'WH_MFO/1', closed: '2026-10-12', condition: 'damaged' }, { key: '6_1', sku: 'WH_MFO/2', closed: '2026-10-12', outcome: 'lost' }],
      settlements: [{ key: '5_1', type: 'return', net: -5000 }, { key: '6_1', type: 'return', net: -5000 }],
    });
    expect(overview(db, {}).total.returnCost).toBe(2 * (5000 + 700 + 12000));
  });

  it('never prices a code without a cost at zero', () => {
    const db = makeDb();
    db.prepare("DELETE FROM costs WHERE code = 'TC_NBC'").run();
    seed(db, { orders: [{ key: '7_1', sku: 'TC_NBC/1', total: 17000 }], settlements: [{ key: '7_1', sale: 17000, net: 12000 }] });
    const t = overview(db, {}).total;
    expect(t.costMissingLines).toBe(1);
    expect(t.profitLines).toBe(0);
    expect(t.profit).toBe(0);
  });

  it('platform columns add up to the combined total', () => {
    const db = makeDb();
    seed(db, {
      orders: [
        { key: '8_1', sku: 'WH_MFO/1', total: 20000 },
        { key: 'OD1:WH_MFO/2', sku: 'WH_MFO/2', total: 28900, extra: { platform: 'flipkart' } },
        { key: 'OD2:TC_BT/3', sku: 'TC_BT/3', total: 37900, extra: { platform: 'shopsy' } },
      ],
    });
    const p = products(db, {}).rows.find((r) => r.name.startsWith('Wall Hanging'));
    expect(p.metrics.all.gmv).toBe(p.metrics.meesho.gmv + p.metrics.flipkart.gmv);
    const o = overview(db, {});
    expect(o.platforms.reduce((a, x) => a + x.gmv, 0)).toBe(o.total.gmv);
  });

  it('the P&L waterfall adds up to its profit', () => {
    const db = makeDb();
    seed(db, {
      orders: [{ key: '9_1', sku: 'WH_MFO/1', total: 20000 }, { key: '10_1', sku: 'TC_NBC/1', total: 17000 }],
      settlements: [{ key: '9_1', sale: 20000, commission: -4000, tax: -300, net: 15700 }],
    });
    db.prepare("DELETE FROM costs WHERE code = 'TC_NBC'").run();
    const w = pnl(db, {}).total;
    const sum = w.steps.filter((s) => !s.subtotal).reduce((a, s) => a + s.value, 0);
    expect(sum).toBe(w.profit);
  });

  it('leaves GST out of profit by default, and deducts it on kept sales when switched on', () => {
    const db = makeDb();
    seed(db, {
      orders: [{ key: '11_1', sku: 'WH_MFO/1', total: 20000 }, { key: '12_1', sku: 'WH_MFO/2', total: 20000 }],
      returns: [{ key: '12_1', sku: 'WH_MFO/2', closed: '2026-10-12' }],
      settlements: [{ key: '11_1', sale: 20000, net: 15000 }, { key: '12_1', type: 'return', net: -6000 }],
    });
    const off = overview(db, {}).total;
    expect(off.gst).toBe(0);
    expect(pnl(db, {}).total.steps.some((s) => s.label === 'GST on kept sales')).toBe(false);

    setSetting(db, 'gst_mode', 'deduct_output');
    const on = overview(db, {}).total;
    // Only the kept sale owes GST; the returned one is reversed by a credit note.
    expect(on.gst).toBe(20000 - Math.round(20000 / 1.12));
    expect(on.profit).toBe(off.profit - on.gst);
  });
});

describe('payment window (paid 7–15 days after dispatch)', () => {
  const seedWindow = (db, extra = []) =>
    seed(db, {
      orders: [
        ...extra,
        // Three settled orders give the payout estimate something to go on.
        ...[1, 2, 3].map((i) => ({ key: `s${i}_1`, sku: 'WH_MFO/1', total: 20000, date: '2026-09-20' })),
        { key: 'a_1', sku: 'WH_MFO/2', total: 20000, date: '2026-10-17' }, // 3 days: not due yet
        { key: 'b_1', sku: 'WH_MFO/3', total: 20000, date: '2026-10-10' }, // 10 days: due now
        { key: 'c_1', sku: 'WH_MFO/4', total: 20000, date: '2026-10-01' }, // 19 days: overdue
        { key: 'r_1', sku: 'WH_MFO/5', total: 20000, date: '2026-10-01' }, // returned: no payment expected
      ],
      returns: [{ key: 'r_1', sku: 'WH_MFO/5', type: 'rto' }],
      settlements: [1, 2, 3].map((i) => ({ key: `s${i}_1`, sale: 20000, net: 15000 })),
    });

  it('splits unsettled orders into not due, due now and overdue', () => {
    const db = makeDb();
    seedWindow(db);
    const p = paymentsDue(db, {}, '2026-10-20');
    expect([p.min, p.max]).toEqual([7, 15]);
    expect([p.notDue.lines, p.dueNow.lines, p.overdue.lines]).toEqual([1, 1, 1]);
    // Each estimated at what the settled ones paid: 75% of sale.
    expect(p.dueNow.paise).toBe(15000);
    // The expected-by-day calendar holds exactly the not-due and due-now money.
    expect(p.byDay.reduce((a, d) => a + d.paise, 0)).toBeCloseTo(30000, -1);
    // "Next 7 days" means 20–26 Oct: all of b_1's money (window ends day 15 = 25 Oct)
    // and a_1's days 7–9 (24–26 Oct) — 3 of its 9 window days.
    expect(p.next7Paise).toBeCloseTo(15000 + (15000 * 3) / 9, -1);
  });

  it('does not call an order overdue when its payment was due before the payment files begin', () => {
    const db = makeDb();
    // Due by 16 Sep; the first imported payment is on 12 Oct (the seed's payment date).
    seedWindow(db, [{ key: 'old_1', sku: 'WH_MFO/6', total: 20000, date: '2026-09-01' }]);
    const p = paymentsDue(db, {}, '2026-10-20');
    expect(p.overdue.lines).toBe(1); // c_1 only: due by 16 Oct, inside the files
    expect(p.beforePaymentFiles).toMatchObject({ lines: 1, paise: 15000 });
    expect(p.paymentFilesFrom).toEqual({ meesho: '2026-10-12' });
    const unpaid = dataHealth(db, '2026-10-20').unpaid;
    expect(unpaid.rows.map((r) => r.order_item_key)).toEqual(['c_1']);
    expect(unpaid.count).toBe(1);
  });

  it('flags as unpaid only what is past 15 days', () => {
    const db = makeDb();
    seedWindow(db, [{ key: 'e_1', sku: 'WH_MFO/6', total: 20000, date: '2026-10-05' }]); // day 15: last day it can pay
    const h = dataHealth(db, '2026-10-20');
    expect(h.unpaid.days).toBe(15);
    // b_1 (10 days) and e_1 (15) are still inside the window; r_1 came back; s1–s3 are paid.
    expect(h.unpaid.rows.map((r) => r.order_item_key)).toEqual(['c_1']);
    expect(paymentsDue(db, {}, '2026-10-20').overdue.lines).toBe(h.unpaid.count);
  });
});

describe('stock', () => {
  const item = (db) => stockReport(db, '2026-10-20').find((s) => s.name.startsWith('Wall Hanging Organizer'));

  it('one 4-pack and one 2-pack SET listing take 6 pieces from the same shelf', () => {
    const db = makeDb();
    addMove(db, { stockItemId: item(db).id, qty: 50, kind: 'opening', date: '2026-10-01' });
    seed(db, { orders: [{ key: '20_1', sku: 'WH_4MFO/1', total: 42900 }, { key: '21_1', sku: 'WH_MFO_SET/9', total: 28900 }] });
    const s = item(db);
    expect(s.on_hand).toBe(44);
    expect(s.packs.find((p) => p.packOf === 4).possible).toBe(11);
  });

  it('restocks a return received in good condition, not a lost one', () => {
    const db = makeDb();
    addMove(db, { stockItemId: item(db).id, qty: 10, kind: 'opening', date: '2026-10-01' });
    seed(db, {
      orders: [{ key: '22_1', sku: 'WH_MFO/1', total: 28900 }, { key: '23_1', sku: 'WH_MFO/2', total: 28900 }],
      returns: [{ key: '22_1', sku: 'WH_MFO/1', closed: '2026-10-12' }, { key: '23_1', sku: 'WH_MFO/2', closed: '2026-10-12', outcome: 'lost' }],
    });
    expect(item(db).on_hand).toBe(10 - 2 - 2 + 2);
  });

  it('counts an open return as in transit, not on the shelf', () => {
    const db = makeDb();
    seed(db, { orders: [{ key: '24_1', sku: 'WH_MFO/1', total: 28900 }], returns: [{ key: '24_1', sku: 'WH_MFO/1' }] });
    const s = item(db);
    expect(s.on_hand).toBe(-2);
    expect(s.inTransit).toBe(2);
  });

  it('on hand is exactly the sum of the ledger', () => {
    const db = makeDb();
    const id = item(db).id;
    addMove(db, { stockItemId: id, qty: 30, kind: 'opening', date: '2026-10-01' });
    addMove(db, { stockItemId: id, qty: 12, kind: 'purchase', date: '2026-10-03' });
    addMove(db, { stockItemId: id, qty: 1, kind: 'writeoff', date: '2026-10-04' });
    seed(db, { orders: [{ key: '25_1', sku: 'WH_1MFO/1', total: 19900 }] });
    const sum = db.prepare('SELECT SUM(qty) n FROM v_stock_ledger WHERE stock_item_id = ?').get(id).n;
    expect(item(db).on_hand).toBe(sum);
    expect(sum).toBe(30 + 12 - 1 - 1);
  });
});

describe('TCS and TDS', () => {
  it('stay out of the P&L steps and profit, and are reported on their own', async () => {
    const { taxCredits } = await import('../src/server/metrics/reports.js');
    const db = makeDb();
    seed(db, {
      orders: [{ key: 't1_1', sku: 'WH_MFO/1', total: 20900 }],
      settlements: [{ key: 't1_1', sale: 20900, tax: -120, net: 20780 }],
    });
    db.prepare("UPDATE settlement_lines SET tcs_paise = -100, tds_paise = -20, payment_date = '2026-10-12', settlement_ref = 'UTR1'").run();
    const w = pnl(db, {}).total;
    expect(w.steps.some((s) => /TCS|TDS/.test(s.label) && !s.subtotal)).toBe(false);
    expect(w.steps.find((s) => s.label === '= Received (before TCS/TDS)').value).toBe(20900);
    expect(w.taxHeldPaise).toBe(120);
    expect(w.bankPaise).toBe(20780);
    // Profit is the same as if the TCS/TDS had never been held back.
    expect(w.profit).toBe(20900 - 12000 - 700);
    const t = taxCredits(db, {});
    expect([t.tcs, t.tds]).toEqual([100, 20]);
    expect(t.months).toEqual([{ month: '2026-10', platform: 'meesho', tcs: 100, tds: 20, unsplit: 0, payments: 1 }]);
  });
});
