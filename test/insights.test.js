import { describe, expect, it } from 'vitest';
import { csv, makeDb, pdf } from './helpers.js';
import { stageFiles } from '../src/server/importers/stage.js';
import { commitImports } from '../src/server/importers/commit.js';
import { naturalKey } from '../src/server/importers/keys.js';
import { buyerKey, normName, paymentMode } from '../src/server/lib/buyer.js';
import { loadLines } from '../src/server/metrics/lines.js';
import { areaReport, customerDetail, customerList } from '../src/server/metrics/customers.js';
import { findAnomalies, setAnomalyReview } from '../src/server/metrics/anomalies.js';
import { buildTools } from '../src/server/ai/tools.js';

/**
 * Buyers, areas, matching files to labels, and alerts. Every buyer, address, order and
 * tracking number here is made up.
 */
async function importAll(db, files) {
  const staged = await stageFiles(db, files);
  const ids = staged.filter((s) => s.status === 'staged').map((s) => s.importId);
  if (ids.length) await commitImports(db, ids);
  return staged;
}

const FK = ({ orderId = 'OD100000000000000101', sku = 'WH_MFO/1', name = 'Asha Verma', street = 'House 4, Gali 2,', city = 'Lucknow', pin = '226017', mode = 'COD', awb = 'FMPP1000000001', invoice = 'TESTFK1000000001' } = {}) => [
  'STD E-Kart Logistics', 'E', `${orderId} ${mode}`, 'Ordered through', `AWB No. ${awb}`, '(Z) LKO/RAJ',
  'Shipping/Customer address:', `Name: ${name},`, street, `HBD: 21 - 10 ${city} - ${pin} , IN-UP`, 'CPD: 27 - 10',
  'Sold By: SAMPLE TRADERS, Testpur - 110001', 'GSTIN: 06AAAAA0000A1ZX',
  'SKU ID | Description QTY', `1 ${sku} | Sample Brand Organizer, 1`, 'Microfiber Organizer',
  'Tax Invoice Order Id: Invoice No: GSTIN: 06AAAAA0000A1ZX', `${orderId} ${invoice} PAN: AAAAA0000A`,
  'Order Date: 21-10-2026, 10:23 AM Invoice Date: 21-10-2026, 10:35', 'AM',
  'Gross Taxable', 'Product Description Qty Discount IGST CESS Total', 'Amount Value',
  'Organizer (pack of 1 253.00 -0.00 240.95 12.05 0.00 253.00', `2) ${sku} Small |`,
  'Handling Fee 1 0.00 0 0.00 0.00 0.00 0.00', 'TOTAL PRICE: 253.00', 'TOTAL QTY: 1',
];

const MS = ({ sub = '514260587900711500_1', sku = 'TC_NBC/1', heading = 'Customer Address Prepaid: Do not collect cash', buyer = ['Test Buyer', 'Pickup 26/10', 'Nuh District, Haryana, 122107'], awb = 'VL1234567890123', invoice = 'abcde100001' } = {}) => [
  heading, ...buyer, 'If undelivered, return to:', 'SAMPLE_TRADERS', 'TESTPUR, Haryana, 110001', awb,
  'Product Details', 'SKU Size Qty Color Order No.', `${sku} Free Size 1 Cream ${sub}`,
  'TAX INVOICE Original For Recipient', 'BILL TO / SHIP TO Sold by : TEST SELLER',
  'Purchase Order No. Invoice No. Order Date Invoice Date', `${sub.split('_')[0]} ${invoice} 19.10.2026 20.10.2026`,
  'Description HSN Qty Gross Amount Discount Taxable Value Taxes Total', 'Cream Lace Table Cover', 'SGST @2.5% :Rs.3.93',
  '40x60 Inch Swirl Pattern 630492 1 Rs.186.00 Rs.21.00 Rs.157.14 Rs.165.00', 'CGST @2.5% :Rs.3.93',
  'Other Charges 630492 NA Rs.0.00 Rs.0 Rs.0.00 Rs.0.00', 'Total Rs.8.18 Rs.165.00',
];

/** Rows straight into the tables, for the metrics tests. */
function seeder(db) {
  const imp = db.prepare("INSERT INTO imports (sha256, file_name, stored_path, status) VALUES ('x', 'seed', 'x', 'committed')").run().lastInsertRowid;
  let n = 0;
  const insert = (table, row) => {
    const full = { ...row, import_id: imp, content_hash: `h${++n}` };
    db.prepare(`INSERT INTO ${table} (${Object.keys(full).join(', ')}) VALUES (${Object.keys(full).map((k) => '@' + k).join(', ')})`).run(full);
  };
  return {
    imp,
    order(o) {
      const platform = o.platform || 'meesho';
      insert('orders', {
        natural_key: naturalKey(platform, 'main', o.key), platform, order_item_key: o.key, order_id: o.orderId || o.key.split(/[_:]/)[0],
        shipment_key: o.ship || o.key, invoice_no: o.invoice ?? null, invoice_date: o.date || '2026-10-05', sku: o.sku || 'WH_MFO/1',
        code: (o.sku || 'WH_MFO/1').split('/')[0], qty: o.qty || 1, total_paise: o.total ?? 20000, cancelled: o.cancelled ? 1 : 0,
        buyer_name: o.name ?? null, buyer_key: o.name && o.pin ? buyerKey(o.name, o.pin) : null, ship_state: o.state ?? null,
        ship_pincode: o.pin ?? null, ship_city: o.city ?? null, ship_address: o.street ?? null, payment_mode: o.mode ?? null, awb: o.awb ?? null,
      });
    },
    settlement(s) {
      const platform = s.platform || 'meesho';
      insert('settlement_lines', {
        natural_key: naturalKey(platform, 'main', `${s.key}|${s.type || 'sale'}|${n}`), platform, order_item_key: s.key, txn_type: s.type || 'sale',
        payment_date: s.paid || '2026-10-12', sale_paise: s.sale ?? 0, commission_paise: s.commission ?? 0, shipping_paise: s.shipping ?? 0,
        penalty_paise: s.penalty ?? 0, net_paise: s.net, invoice_no: s.invoice ?? null, order_id: s.orderId ?? null,
      });
    },
    ret(r) {
      const platform = r.platform || 'meesho';
      insert('returns', {
        natural_key: naturalKey(platform, 'main', r.key), platform, return_key: r.key, order_item_key: r.key, sku: r.sku || 'WH_MFO/1',
        code: (r.sku || 'WH_MFO/1').split('/')[0], return_type: r.type || 'customer', reason: r.reason || 'Size issue', created_date: '2026-10-08',
        closed_date: '2026-10-14', status: 'closed', outcome: 'received', tracking_id: r.tracking ?? null, invoice_no: r.invoice ?? null,
      });
    },
  };
}

describe('buyers from labels', () => {
  it('reads name, street, city, COD and AWB from a Flipkart label', async () => {
    const db = makeDb();
    await importAll(db, [{ buffer: pdf([FK()]), fileName: 'invoice_labels.pdf' }]);
    expect(db.prepare('SELECT buyer_name, buyer_key, ship_address, ship_city, ship_pincode, payment_mode, awb FROM orders').get()).toEqual({
      buyer_name: 'Asha Verma', buyer_key: 'asha verma|226017', ship_address: 'House 4, Gali 2', ship_city: 'Lucknow',
      ship_pincode: '226017', payment_mode: 'cod', awb: 'FMPP1000000001',
    });
  });

  it('reads a Meesho label past courier lines and routing codes, "payable amount" as COD, and a Shadowfax AWB', async () => {
    const db = makeDb();
    const page = MS({
      heading: 'Customer Address Check the payable amount on the app',
      buyer: ['Ravi Kumar', 'C/O Mohan Lal,', 'Pickup 26/10', 'Valmo', 'Ward 5 Near Temple JXO-R0', 'Testgarh District, Bihar, 851204 JXO-R0'],
      awb: 'SF1234567890FPL',
    });
    await importAll(db, [{ buffer: pdf([page]), fileName: 'Sub_Order_Labels.pdf' }]);
    expect(db.prepare('SELECT buyer_name, buyer_key, ship_address, ship_city, ship_pincode, ship_state, payment_mode, awb FROM orders').get()).toEqual({
      buyer_name: 'Ravi Kumar', buyer_key: 'ravi kumar|851204', ship_address: 'C/O Mohan Lal, Ward 5 Near Temple', ship_city: 'Testgarh',
      ship_pincode: '851204', ship_state: 'Bihar', payment_mode: 'cod', awb: 'SF1234567890FPL',
    });
  });

  it('treats the same name at the same PIN code as one buyer', () => {
    expect(buyerKey('Mr. Ramesh  Kumar', '110001')).toBe(buyerKey('RAMESH KUMAR', '110001'));
    expect(buyerKey('Smt. Kavita Devi', '110001')).toBe('kavita devi|110001');
    expect(buyerKey('Ramesh Kumar', '110002')).not.toBe(buyerKey('Ramesh Kumar', '110001'));
    expect(buyerKey('Ramesh Kumar', null)).toBeNull();
    expect(normName('  ')).toBeNull();
    expect([paymentMode('Prepaid: Do not collect cash'), paymentMode('COD: Check the payable amount on the app'), paymentMode('Check the payable amount on the app'), paymentMode('cod'), paymentMode('')])
      .toEqual(['prepaid', 'cod', 'cod', 'cod', null]);
  });
});

describe('matching payments and returns to labels', () => {
  const RET_HEAD = ['Order ID', 'Order Item ID', 'Return ID', 'Tracking ID', 'SKU', 'Total Price', 'Quantity', 'Return Requested Date', 'Completed Date',
    'Return Status', 'Completion Status', 'Return Type', 'Return Reason', 'Invoice Number'];

  it('joins a return whose SKU reads differently to its label by the AWB, as one line', async () => {
    const db = makeDb();
    await importAll(db, [{ buffer: pdf([FK()]), fileName: 'invoice_labels.pdf' }]);
    const returns = csv([RET_HEAD, ['OD100000000000000101', '1', 'R100', 'FMPP1000000001', 'WH_MFO/9', '253.0', '1', '22 October, 2026', '', 'in_transit', 'Open', 'courier_return', 'Attempts_Exhausted', '']]);
    await importAll(db, [{ buffer: returns, fileName: 'returns.csv' }]);
    const lines = loadLines(db, {});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ return_type: 'rto', linked_via: 'awb', buyer_name: 'Asha Verma', line_source: 'invoice' });
  });

  it('matches by invoice number first, and never guesses between two lines of one order', () => {
    const db = makeDb();
    const s = seeder(db);
    s.order({ platform: 'flipkart', key: 'OD9:A/1', orderId: 'OD9', sku: 'WH_MFO/1', invoice: 'INV9', awb: 'AWB9' });
    s.order({ platform: 'flipkart', key: 'OD9:B/1', orderId: 'OD9', sku: 'TC_BT/1', invoice: 'INV9', awb: 'AWB9' });
    s.order({ platform: 'flipkart', key: 'OD8:A/1', orderId: 'OD8', sku: 'WH_MFO/1', invoice: 'INV8' });
    // Same order ID, a SKU no label has: two lines could be meant, so it stays apart.
    s.settlement({ platform: 'flipkart', key: 'OD9:X/1', orderId: 'OD9', invoice: 'INV9', sale: 1000, net: 800 });
    // A unique invoice number is enough.
    s.settlement({ platform: 'flipkart', key: 'OD8:Z/1', orderId: 'OD8', invoice: 'INV8', sale: 20000, net: 17000 });
    const lines = loadLines(db, {});
    expect(lines).toHaveLength(4);
    expect(lines.find((l) => l.order_item_key === 'OD8:A/1')).toMatchObject({ linked_via: 'invoice', settled_net: 17000 });
    expect(lines.find((l) => l.order_item_key === 'OD9:X/1')).toMatchObject({ line_source: 'payment', linked_via: null });
  });

  it('raises an alert when a payment or an RTO names a different invoice or AWB than the label', () => {
    const db = makeDb();
    const s = seeder(db);
    s.order({ platform: 'flipkart', key: 'OD7:A/1', orderId: 'OD7', invoice: 'INV7', awb: 'AWB7' });
    s.settlement({ platform: 'flipkart', key: 'OD7:A/1', invoice: 'INV-OTHER', sale: 20000, net: 17000 });
    s.ret({ platform: 'flipkart', key: 'OD7:A/1', type: 'rto', tracking: 'AWB-OTHER' });
    const types = findAnomalies(db, {}, { today: '2026-10-22' }).items.map((a) => a.type);
    expect(types).toContain('id_mismatch');
    expect(types).toContain('awb_mismatch');
  });
});

describe('customers and areas', () => {
  function shop() {
    const db = makeDb();
    const s = seeder(db);
    // Asha: 3 orders, 2 returned. Ravi: one COD order that came back as RTO. Meena: 2 kept.
    for (const [i, ret] of [[1, true], [2, true], [3, false]]) {
      s.order({ key: `A${i}_1`, name: 'Asha Verma', pin: '226017', city: 'Lucknow', state: 'Uttar Pradesh', mode: 'prepaid', date: `2026-10-0${i}` });
      s.settlement({ key: `A${i}_1`, sale: 20000, net: 17000 });
      if (ret) s.ret({ key: `A${i}_1`, reason: 'Size issue' });
    }
    s.order({ key: 'R1_1', name: 'Ravi Kumar', pin: '851204', city: 'Testgarh', state: 'Bihar', mode: 'cod' });
    s.ret({ key: 'R1_1', type: 'rto' });
    for (const i of [1, 2]) {
      s.order({ key: `M${i}_1`, name: 'Smt. Meena Rao', pin: '560001', city: 'Bengaluru', state: 'Karnataka', mode: 'prepaid' });
      s.settlement({ key: `M${i}_1`, sale: 20000, net: 17000 });
    }
    // Uttar Pradesh gets enough orders to count as an area: 3 more kept ones from other buyers.
    for (const i of [1, 2, 3]) {
      s.order({ key: `U${i}_1`, name: `Buyer ${i}`, pin: '226010', city: 'Lucknow', state: 'Uttar Pradesh', mode: 'prepaid' });
      s.settlement({ key: `U${i}_1`, sale: 20000, net: 17000 });
    }
    return db;
  }

  it('lists buyers with how their orders went, and flags them', () => {
    const db = shop();
    const { rows, summary } = customerList(db, {});
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by['Asha Verma']).toMatchObject({ orders: 3, returned: 2, rto: 0, flags: { repeat: true, frequentReturner: true, good: false } });
    expect(by['Ravi Kumar']).toMatchObject({ orders: 1, rto: 1, flags: { rtoRisk: true, repeat: false } });
    expect(by['Smt. Meena Rao']).toMatchObject({ orders: 2, returned: 0, flags: { good: true, frequentReturner: false } });
    expect(summary).toMatchObject({ buyers: 6, repeatBuyers: 2, frequentReturners: 1, rtoRisk: 1 });
    expect(customerList(db, {}, { q: '560001' }).rows.map((r) => r.name)).toEqual(['Smt. Meena Rao']);

    const asha = customerDetail(db, 'asha verma|226017');
    expect(asha.history.map((h) => h.outcome)).toEqual(['kept', 'returned', 'returned']);
    expect(asha.history[1]).toMatchObject({ reason: 'Size issue' });
  });

  it('splits returns by state with rates that add up, and flags only areas with enough orders', () => {
    const r = areaReport(shop(), {}, { level: 'state' });
    expect(r.rows.reduce((a, x) => a + x.orders, 0)).toBe(r.total.orders);
    const up = r.rows.find((x) => x.key === 'Uttar Pradesh');
    const bihar = r.rows.find((x) => x.key === 'Bihar');
    expect(up).toMatchObject({ orders: 6, returnsCustomer: 2 });
    // Bihar returned 1 of 1 — far above average, but one order is not a pattern.
    expect(bihar).toMatchObject({ orders: 1, returnsRto: 1, aboveAverage: false });
    expect(up.aboveAverage).toBe(up.returnRate > r.total.returnRate);
    expect(r.byPaymentMode.find((m) => m.key === 'cod')).toMatchObject({ orders: 1, returnsRto: 1 });
    expect(areaReport(shop(), {}, { level: 'city', state: 'Uttar Pradesh' }).rows.map((x) => x.key)).toEqual(['Lucknow, Uttar Pradesh']);
  });
});

describe('alerts', () => {
  it('flags a low payout, a penalty and a paid cancelled order, and stays quiet on normal sales', () => {
    const db = makeDb();
    const s = seeder(db);
    for (const i of [1, 2, 3, 4]) {
      s.order({ key: `N${i}_1` });
      s.settlement({ key: `N${i}_1`, sale: 20000, net: 17000 });
    }
    s.order({ key: 'LOW_1' });
    s.settlement({ key: 'LOW_1', sale: 20000, net: 11000 });
    s.order({ key: 'PEN_1' });
    s.settlement({ key: 'PEN_1', sale: 20000, penalty: -500, net: 16500 });
    s.order({ key: 'CAN_1', cancelled: true });
    s.settlement({ key: 'CAN_1', sale: 20000, net: 17000 });
    const a = findAnomalies(db, {}, { today: '2026-10-22' });
    const of = (type) => a.items.filter((x) => x.type === type).map((x) => x.naturalKey || x.orderId);
    expect(of('payout_low')).toEqual(['meesho|main|LOW_1']);
    expect(of('deduction')).toEqual(['meesho|main|PEN_1']);
    expect(a.items.filter((x) => x.type === 'paid_cancelled')).toHaveLength(1);
    expect(a.items.some((x) => /N\d_1/.test(x.naturalKey || ''))).toBe(false);
    expect(a.counts.high).toBe(3);
  });

  it('Mark OK hides an alert for good; Follow up pins it to the top', () => {
    const db = makeDb();
    const s = seeder(db);
    s.order({ key: 'P1_1' });
    s.settlement({ key: 'P1_1', sale: 20000, penalty: -500, net: 16500 });
    s.order({ key: 'P2_1' });
    s.settlement({ key: 'P2_1', sale: 20000, penalty: -900, net: 16100, paid: '2026-10-01' });
    const [first, second] = findAnomalies(db, {}, { today: '2026-10-22' }).items;
    setAnomalyReview(db, first.key, 'ok');
    setAnomalyReview(db, second.key, 'follow_up');
    const after = findAnomalies(db, {}, { today: '2026-10-22' });
    expect(after.items.map((i) => i.key)).toEqual([second.key]);
    expect(after.reviewedOk).toBe(1);
    expect(findAnomalies(db, {}, { today: '2026-10-22', reviewed: true }).items[0].key).toBe(second.key);
    setAnomalyReview(db, first.key, '');
    expect(findAnomalies(db, {}, { today: '2026-10-22' }).items).toHaveLength(2);
  });

  it('flags a return charge with no returns-file row only once the returns files cover its time', () => {
    const run = (coverFrom) => {
      const db = makeDb();
      const s = seeder(db);
      db.prepare("INSERT INTO imports (sha256, file_name, stored_path, kind, platform, status, date_from) VALUES ('r', 'r.csv', 'r', 'meesho.returns', 'meesho', 'committed', ?)").run(coverFrom);
      s.order({ key: 'RT_1' });
      s.settlement({ key: 'RT_1', type: 'return', sale: 20000, net: -3000, paid: '2026-10-12' });
      return findAnomalies(db, {}, { today: '2026-10-22' }).items.filter((a) => a.type === 'return_unrecorded').length;
    };
    expect(run('2026-09-01')).toBe(1);
    expect(run('2026-10-10')).toBe(0);
  });
});

describe('privacy', () => {
  it('gives the AI tools no buyer name, street or PIN code', async () => {
    const db = makeDb();
    const s = seeder(db);
    for (const i of [1, 2, 3, 4, 5, 6]) {
      s.order({ key: `Z${i}_1`, name: 'Zubeida Quorrington', street: 'Flat 9 Xylophone Lane', pin: '560034', city: 'Bengaluru', state: 'Karnataka', mode: 'cod' });
      s.settlement({ key: `Z${i}_1`, sale: 20000, penalty: i === 1 ? -500 : 0, net: 17000 });
    }
    const tools = buildTools(db);
    for (const [name, tool] of Object.entries(tools)) {
      if (tool.parameters.required?.length) continue;
      for (const args of name === 'get_areas' ? [{}, { level: 'city' }, { level: 'zone' }] : [{}]) {
        const out = JSON.stringify(await tool.run(args));
        expect(out, name).not.toMatch(/Zubeida|Quorrington|Xylophone|560034/);
      }
    }
  });
});
