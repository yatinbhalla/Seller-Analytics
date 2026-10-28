import { describe, expect, it } from 'vitest';
import { makeDb } from './helpers.js';
import { contentHash, naturalKey } from '../src/server/importers/keys.js';
import { loadPayments, paymentList, paymentReport } from '../src/server/metrics/payments.js';
import { setSetting } from '../src/server/db/db.js';

/** Insert rows straight into the tables, as a committed import would leave them. */
function seed(db, { orders = [], returns = [], payments = [] }) {
  const imp = db.prepare("INSERT INTO imports (sha256, file_name, stored_path, status) VALUES (?, 'seed', 'x', 'committed')")
    .run(`seed-${Math.random()}`).lastInsertRowid;
  for (const o of orders) {
    const row = {
      platform: o.platform || 'meesho', account: 'main', order_id: o.key.split('_')[0], shipment_key: o.ship || o.key, invoice_no: null,
      invoice_date: o.date || '2026-10-01', order_date: null, sku: o.sku, code: o.sku.split('/')[0].toUpperCase(), qty: o.qty || 1,
      gross_paise: o.total, discount_paise: 0, taxable_paise: Math.round(o.total / 1.12), tax_paise: o.total - Math.round(o.total / 1.12),
      total_paise: o.total, ship_state: o.state || null, ship_pincode: null, cancelled: 0, order_item_key: o.key,
    };
    db.prepare(`INSERT INTO orders (natural_key, ${Object.keys(row).join(', ')}, import_id, source_ref, content_hash)
                VALUES (@natural_key, ${Object.keys(row).map((k) => '@' + k).join(', ')}, @import_id, 'seed', @content_hash)`)
      .run({ ...row, natural_key: naturalKey(row.platform, 'main', o.key), import_id: imp, content_hash: contentHash(row) });
  }
  for (const r of returns) {
    db.prepare(`INSERT INTO returns (natural_key, platform, return_key, order_item_key, sku, code, qty, return_type, reason, created_date,
                closed_date, status, outcome, condition, import_id, content_hash)
                VALUES (?, 'meesho', ?, ?, ?, ?, 1, ?, 'Size issue', '2026-10-08', ?, ?, ?, ?, ?, 'h')`)
      .run(naturalKey('meesho', 'main', r.key), r.key, r.key, r.sku, r.sku.split('/')[0], r.type || 'customer',
        r.open ? null : '2026-10-12', r.open ? 'open' : 'closed', r.outcome || (r.open ? null : 'received'), r.condition || null, imp);
  }
  payments.forEach((p, i) => {
    const m = { sale: 0, refund: 0, commission: 0, shipping: 0, reverse: 0, tax: 0, penalty: 0, claim: 0, ads: 0, ...p };
    const net = m.sale + m.refund + m.commission + m.shipping + m.reverse + m.tax + m.penalty + m.claim + m.ads;
    db.prepare(`INSERT INTO settlement_lines (natural_key, platform, order_item_key, sku, code, txn_type, payment_date, sale_paise, refund_paise,
                commission_paise, shipping_paise, reverse_ship_paise, tax_withheld_paise, penalty_paise, claim_paise, ads_paise, net_paise,
                import_id, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'h')`)
      .run(naturalKey(p.platform || 'meesho', 'main', `${p.key || 'none'}|${p.type || 'sale'}|${i}`), p.platform || 'meesho', p.key || null, p.sku || null,
        p.sku ? p.sku.split('/')[0] : null, p.type || 'sale', p.date || '2026-10-12', m.sale, m.refund, m.commission, m.shipping,
        m.reverse, m.tax, m.penalty, m.claim, m.ads, net, imp);
  });
}

const one = (db, key) => loadPayments(db).filter((e) => e.itemKey === key);

describe('profit from each payment', () => {
  it('a kept sale: money received, TCS/TDS added back, cost of goods and the ₹7 packet taken off', () => {
    const db = makeDb();
    seed(db, {
      orders: [{ key: 's_1', sku: 'WH_MFO/1', total: 20000 }],
      payments: [{ key: 's_1', sku: 'WH_MFO/1', sale: 20000, commission: -2000, shipping: -3000, tax: -100 }],
    });
    const [e] = one(db, 's_1');
    expect(e.kind).toBe('sale');
    expect(e.net).toBe(14900);
    expect(e.received).toBe(15000);
    expect([e.cost, e.packet]).toEqual([12000, 700]);
    expect(e.profit).toBe(14900 + 100 - 12000 - 700);
  });

  it('a return that came back fine costs its charges and the packet, not the goods', () => {
    const db = makeDb();
    seed(db, {
      orders: [{ key: 'r_1', sku: 'WH_MFO/1', total: 20000 }],
      returns: [{ key: 'r_1', sku: 'WH_MFO/1' }],
      payments: [{ key: 'r_1', sku: 'WH_MFO/1', type: 'return', sale: 20000, refund: -20000, reverse: -6500 }],
    });
    const [e] = one(db, 'r_1');
    expect(e.restocked).toBe(true);
    expect(e.profit).toBe(-6500 - 700);
  });

  it('a damaged return, or one still on its way, also loses the goods', () => {
    const db = makeDb();
    seed(db, {
      orders: [{ key: 'd_1', sku: 'WH_MFO/1', total: 20000 }, { key: 't_1', sku: 'WH_MFO/2', total: 20000 }],
      returns: [{ key: 'd_1', sku: 'WH_MFO/1', condition: 'damaged' }, { key: 't_1', sku: 'WH_MFO/2', type: 'rto', open: true }],
      payments: [
        { key: 'd_1', sku: 'WH_MFO/1', type: 'return', sale: 20000, refund: -20000, reverse: -6500 },
        { key: 't_1', sku: 'WH_MFO/2', type: 'rto', sale: 20000, refund: -20000 },
      ],
    });
    expect(one(db, 'd_1')[0].profit).toBe(-6500 - 700 - 12000);
    expect(one(db, 't_1')[0].profit).toBe(-700 - 12000);
  });

  it('an RTO that came back costs only the packet', () => {
    const db = makeDb();
    seed(db, {
      orders: [{ key: 'o_1', sku: 'WH_MFO/1', total: 20000 }],
      returns: [{ key: 'o_1', sku: 'WH_MFO/1', type: 'rto' }],
      payments: [{ key: 'o_1', sku: 'WH_MFO/1', type: 'rto', sale: 20000, refund: -20000 }],
    });
    expect(one(db, 'o_1')[0].profit).toBe(-700);
  });

  it('a sale paid and later reversed gives the cost back when the item is restocked, and the packet is charged once', () => {
    const db = makeDb();
    seed(db, {
      orders: [{ key: 'b_1', sku: 'WH_MFO/1', total: 20000 }],
      returns: [{ key: 'b_1', sku: 'WH_MFO/1' }],
      payments: [
        { key: 'b_1', sku: 'WH_MFO/1', sale: 20000, commission: -5100, date: '2026-10-10' },
        { key: 'b_1', sku: 'WH_MFO/1', type: 'return', refund: -20000, reverse: -6500, date: '2026-10-20' },
      ],
    });
    const [sale, ret] = one(db, 'b_1');
    expect(sale.profit).toBe(14900 - 12000 - 700);
    expect([ret.cost, ret.packet]).toEqual([-12000, 0]);
    expect(ret.profit).toBe(-26500 + 12000);
    // Over both payments: all the money the order moved, less the one packet.
    expect(sale.profit + ret.profit).toBe(14900 - 26500 - 700);
  });

  it('shares one ₹7 between items in the same packet', () => {
    const db = makeDb();
    seed(db, {
      orders: [{ key: 'p_1', sku: 'WH_MFO/1', total: 20000, ship: 'P1' }, { key: 'p_2', sku: 'TC_BT/1', total: 23000, ship: 'P1' }],
      payments: [{ key: 'p_1', sku: 'WH_MFO/1', sale: 20000 }, { key: 'p_2', sku: 'TC_BT/1', sale: 23000 }],
    });
    expect(loadPayments(db).reduce((a, e) => a + e.packet, 0)).toBe(700);
  });

  it('penalties, claims and ads count as they are paid, with no goods or packet', () => {
    const db = makeDb();
    seed(db, {
      orders: [{ key: 'x_1', sku: 'WH_MFO/1', total: 20000 }],
      payments: [
        { key: 'x_1', sku: 'WH_MFO/1', type: 'adjustment', penalty: -2500 },
        { key: 'x_1', sku: 'WH_MFO/1', type: 'claim', claim: 1500 },
        { type: 'ads', ads: -4000 },
      ],
    });
    const e = loadPayments(db);
    expect(e.map((x) => x.kind)).toEqual(['penalty', 'claim', 'ads']);
    expect(e.map((x) => x.profit)).toEqual([-2500, 1500, -4000]);
  });

  it('never counts a missing cost price as zero, and the breakdown still adds up', () => {
    const db = makeDb();
    db.prepare("DELETE FROM costs WHERE code = 'TC_NBC'").run();
    seed(db, {
      orders: [{ key: 'm_1', sku: 'TC_NBC/1', total: 17000 }, { key: 'k_1', sku: 'WH_MFO/1', total: 20000 }],
      payments: [{ key: 'm_1', sku: 'TC_NBC/1', sale: 17000, commission: -5000 }, { key: 'k_1', sku: 'WH_MFO/1', sale: 20000, tax: -200 }],
    });
    const r = paymentReport(db, {});
    expect(r.total.costMissing).toBe(1);
    expect(r.total.profit).toBe(19800 + 200 - 12000 - 700);
    const steps = r.breakdown.steps;
    expect(steps.filter((s) => !s.subtotal).reduce((a, s) => a + s.value, 0)).toBe(r.breakdown.profit);
    expect(steps.find((s) => s.label === '= Received (before TCS/TDS)').value).toBe(12000 + 20000);
    expect(r.breakdown.bankPaise).toBe(12000 + 19800);
    expect(r.breakdown.taxHeldPaise).toBe(200);
  });

  it('takes GST off a kept sale when switched on, and gives it back on a later return', () => {
    const db = makeDb();
    setSetting(db, 'gst_mode', 'deduct_output');
    seed(db, {
      orders: [{ key: 'g_1', sku: 'WH_MFO/1', total: 20000 }],
      returns: [{ key: 'g_1', sku: 'WH_MFO/1' }],
      payments: [
        { key: 'g_1', sku: 'WH_MFO/1', sale: 20000, date: '2026-10-10' },
        { key: 'g_1', sku: 'WH_MFO/1', type: 'return', refund: -20000, date: '2026-10-20' },
      ],
    });
    const gst = 20000 - Math.round(20000 / 1.12);
    expect(one(db, 'g_1').map((e) => e.gst)).toEqual([gst, -gst]);
  });

  it('the date range is the payment date, not the order date', () => {
    const db = makeDb();
    seed(db, {
      orders: [{ key: 'a_1', sku: 'WH_MFO/1', total: 20000, date: '2026-09-25' }],
      payments: [{ key: 'a_1', sku: 'WH_MFO/1', sale: 20000, date: '2026-10-05' }],
    });
    expect(paymentReport(db, { from: '2026-10-01', to: '2026-10-31' }).total.payments).toBe(1);
    expect(paymentReport(db, { from: '2026-09-01', to: '2026-09-30' }).total.payments).toBe(0);
  });
});

describe('why the same SKU is paid differently', () => {
  // Flipkart takes its shipping off the price the buyer saw, so shipping moves the payout.
  const seedFlipkart = (db) =>
    seed(db, {
      orders: ['1', '2', '3', '4'].map((i) => ({ key: `u${i}_1`, sku: 'WH_MFO/1', total: 20000, platform: 'flipkart' })),
      payments: [
        { key: 'u1_1', sku: 'WH_MFO/1', sale: 18000, shipping: -4000, platform: 'flipkart' },
        { key: 'u2_1', sku: 'WH_MFO/1', sale: 20000, shipping: -4500, platform: 'flipkart' },
        { key: 'u3_1', sku: 'WH_MFO/1', sale: 21000, shipping: -4000, platform: 'flipkart' },
        { key: 'u4_1', sku: 'WH_MFO/1', sale: 20000, shipping: -9000, platform: 'flipkart' },
      ],
    });
  // Meesho adds its shipping on top of the seller's price, so the buyer's price swings
  // with distance while the payout does not.
  const seedMeesho = (db) =>
    seed(db, {
      orders: ['1', '2', '3', '4'].map((i) => ({ key: `m${i}_1`, sku: 'WH_MFO/1', total: 20000 })),
      payments: [
        { key: 'm1_1', sku: 'WH_MFO/1', sale: 18000, shipping: -4000 },
        { key: 'm2_1', sku: 'WH_MFO/1', sale: 20000, shipping: -6000 },
        { key: 'm3_1', sku: 'WH_MFO/1', sale: 21000, shipping: -7000 },
        { key: 'm4_1', sku: 'WH_MFO/1', sale: 17000, shipping: -2000 },
      ],
    });

  it('gives each SKU its usual payout, range and what moves it', () => {
    const db = makeDb();
    seedFlipkart(db);
    const sku = paymentReport(db, {}).skus.find((s) => s.code === 'WH_MFO');
    expect(sku.sales).toBe(4);
    expect([sku.payout.low, sku.payout.usual, sku.payout.high]).toEqual([11000, 14000, 17000]);
    expect(sku.payout.drivers.map((d) => d.part).sort()).toEqual(['price', 'shipping']);
    // Usual: an 18,000 buyer price, of which Flipkart kept 4,000.
    expect([sku.payout.usualPrice, sku.payout.usualKept]).toEqual([18000, 4000]);
  });

  it("splits a payment's gap from the usual one into parts that add up exactly", () => {
    const db = makeDb();
    seedFlipkart(db);
    const rows = paymentList(db, {}).rows;
    for (const r of rows) {
      expect(r.vsUsual.parts.reduce((a, p) => a + p.diff, 0)).toBe(r.vsUsual.gap);
    }
    const far = rows.find((r) => r.itemKey === 'u4_1').vsUsual;
    expect(far.gap).toBe(11000 - 14000);
    expect(far.parts).toEqual([{ part: 'shipping', label: 'Shipping', diff: -5000 }, { part: 'price', label: 'Price the buyer paid', diff: 2000 }]);
  });

  it("on Meesho, the shipping the buyer pays never counts as moving the payout; the seller's own price does", () => {
    const db = makeDb();
    seedMeesho(db);
    const sku = paymentReport(db, {}).skus.find((s) => s.code === 'WH_MFO');
    expect(sku.payout.drivers.map((d) => d.part)).toEqual(['price']);
    expect(sku.payout.drivers[0].label).toBe('Your price (buyer price less Meesho shipping)');
    expect([sku.payout.usualPrice, sku.payout.usualKept]).toEqual([14000, 0]);
    const rows = paymentList(db, {}).rows;
    // Same own price, different distance: the same payout, nothing to explain.
    expect(rows.find((r) => r.itemKey === 'm1_1').vsUsual).toEqual({ usual: 14000, gap: 0, parts: [] });
    const higher = rows.find((r) => r.itemKey === 'm4_1');
    expect(higher.vsUsual.parts).toEqual([{ part: 'price', label: 'Your price (buyer price less Meesho shipping)', diff: 1000 }]);
    expect(higher.buyerShipping).toBe(2000);
  });

  it('shows the payout of each listing copy of a code', () => {
    const db = makeDb();
    seed(db, {
      orders: ['1', '2', '3', '4'].map((i) => ({ key: `c${i}_1`, sku: i < '3' ? 'WH_MFO/1' : 'WH_MFO/40365', total: 20000 })),
      payments: [
        { key: 'c1_1', sku: 'WH_MFO/1', sale: 17000, shipping: -4000 },
        { key: 'c2_1', sku: 'WH_MFO/1', sale: 19000, shipping: -6000 },
        { key: 'c3_1', sku: 'WH_MFO/40365', sale: 21000, shipping: -5000 },
        { key: 'c4_1', sku: 'WH_MFO/40365', sale: 18000, shipping: -2000 },
      ],
    });
    const sku = paymentReport(db, {}).skus.find((s) => s.code === 'WH_MFO');
    expect(sku.payout.byListing.map((l) => [l.sku, l.n, l.payout]).sort()).toEqual([['WH_MFO/1', 2, 13000], ['WH_MFO/40365', 2, 16000]]);
  });
});
