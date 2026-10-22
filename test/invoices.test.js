import { describe, expect, it } from 'vitest';
import { flipkartInvoiceLines, makeDb, meeshoInvoiceLines, pdf } from './helpers.js';
import { stageFiles } from '../src/server/importers/stage.js';
import { commitImports } from '../src/server/importers/commit.js';
import { readPdfPages } from '../src/server/importers/pdf.js';
import flipkartInvoices from '../src/server/importers/flipkart/invoices.js';
import meeshoInvoices from '../src/server/importers/meesho/invoices.js';

describe('PDF text extraction', () => {
  it('reads back lines in reading order', async () => {
    const pages = await readPdfPages(pdf([['Tax Invoice', 'Order Id: OD074185296307418529'], ['second page']]));
    expect(pages).toHaveLength(2);
    expect(pages[0].lines).toEqual(['Tax Invoice', 'Order Id: OD074185296307418529']);
  });
});

describe('Flipkart invoice PDF', () => {
  it('imports one line per SKU, keeps only state and pincode of the buyer', async () => {
    const db = makeDb();
    const file = pdf([
      flipkartInvoiceLines({ orderId: 'OD033333333333333330', items: [{ sku: 'WH_MFO/40365', qty: 1, total: 289 }] }),
      flipkartInvoiceLines({ orderId: 'OD033333333333333337', invoiceNo: 'FAB7654321', shopsy: true, items: [{ sku: 'TC_BT/1.1', qty: 1, total: 379 }, { sku: 'WH_4MFO/2', qty: 1, total: 429 }] }),
    ]);
    const [res] = await stageFiles(db, [{ buffer: file, fileName: 'labels.pdf' }]);
    expect(res.status).toBe('staged');
    expect(res.summary).toMatchObject({ kind: 'flipkart.invoices', pages: 2, new: 3, rejected: 0 });
    await commitImports(db, [res.importId]);

    const rows = db.prepare('SELECT * FROM orders ORDER BY id').all();
    expect(rows.map((r) => [r.platform, r.sku, r.code, r.total_paise, r.invoice_date])).toEqual([
      ['flipkart', 'WH_MFO/40365', 'WH_MFO', 28900, '2026-10-05'],
      ['shopsy', 'TC_BT/1.1', 'TC_BT', 37900, '2026-10-05'],
      ['shopsy', 'WH_4MFO/2', 'WH_4MFO', 42900, '2026-10-05'],
    ]);
    expect(rows[0]).toMatchObject({ ship_state: 'Maharashtra', ship_pincode: '411001' });
    // Two lines on one label are one packet.
    expect(rows[1].shipment_key).toBe(rows[2].shipment_key);
    // No buyer name anywhere in the row.
    expect(JSON.stringify(rows)).not.toMatch(/Ramesh|MG Road/);
  });

  it('quarantines a page whose lines do not add up to the grand total', () => {
    const lines = flipkartInvoiceLines({ orderId: 'OD033333333333333334', items: [{ sku: 'TC_BT/9', qty: 1, total: 379 }] })
      .map((l) => (l.startsWith('Grand Total') ? 'Grand Total ₹ 999.00' : l));
    const { rows, rejected } = flipkartInvoices.parse({ pages: [{ pageNo: 1, lines }] });
    expect(rows).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/invoice says 999/);
  });

  it('quarantines a page when label qty and invoice qty disagree', () => {
    const lines = flipkartInvoiceLines({ orderId: 'OD033333333333333331', items: [{ sku: 'TC_BT/9', qty: 2, total: 758 }] })
      .map((l) => l.replace('Wall organizer 2 ', 'Wall organizer 1 '));
    const { rejected } = flipkartInvoices.parse({ pages: [{ pageNo: 1, lines }] });
    expect(rejected[0].reason).toMatch(/label says qty 2/);
  });

  it('quarantines a blank page instead of guessing', () => {
    const { rows, rejected } = flipkartInvoices.parse({ pages: [{ pageNo: 3, lines: [] }] });
    expect(rows).toHaveLength(0);
    expect(rejected[0]).toMatchObject({ rowNo: 'page 3' });
  });

  it('re-uploading the next day\'s PDF that repeats an order adds nothing', async () => {
    const db = makeDb();
    const p1 = flipkartInvoiceLines({ orderId: 'OD033333333333333330', items: [{ sku: 'WH_MFO/40365', qty: 1, total: 289 }] });
    const p2 = flipkartInvoiceLines({ orderId: 'OD033333333333333338', invoiceNo: 'FAB5', items: [{ sku: 'TC_BT/7', qty: 1, total: 379 }] });
    const [a] = await stageFiles(db, [{ buffer: pdf([p1]), fileName: 'day1.pdf' }]);
    await commitImports(db, [a.importId]);
    const [b] = await stageFiles(db, [{ buffer: pdf([p1, p2]), fileName: 'day2.pdf' }]);
    expect(b.summary).toMatchObject({ unchanged: 1, new: 1 });
    await commitImports(db, [b.importId]);
    expect(db.prepare('SELECT COUNT(*) n FROM orders').get().n).toBe(2);
  });
});

describe('Meesho invoice PDF', () => {
  it('reads sub-orders, SKUs and amounts', async () => {
    const db = makeDb();
    const file = pdf([meeshoInvoiceLines({ items: [{ sku: 'WH_MFO/40365', subOrder: '008664172757204845_1', qty: 1, total: 200 }] })]);
    const [res] = await stageFiles(db, [{ buffer: file, fileName: 'meesho-labels.pdf' }]);
    expect(res.summary).toMatchObject({ kind: 'meesho.invoices', new: 1, rejected: 0 });
    await commitImports(db, [res.importId]);
    expect(db.prepare('SELECT * FROM orders').get()).toMatchObject({
      platform: 'meesho', order_item_key: '008664172757204845_1', order_id: '008664172757204845', invoice_no: 'mso12345',
      invoice_date: '2026-10-05', code: 'WH_MFO', total_paise: 20000, ship_state: 'Rajasthan', ship_pincode: '302001',
    });
  });

  it('quarantines a page with two SKUs but one invoice line', () => {
    const lines = meeshoInvoiceLines({
      items: [{ sku: 'WH_MFO/1', subOrder: '0086641727572048_1', qty: 1, total: 200 }, { sku: 'TC_BT/1', subOrder: '0086641727572048_2', qty: 1, total: 230 }],
    }).filter((l) => !l.includes('Rs.230.00 Rs.0.00'));
    const { rejected } = meeshoInvoices.parse({ pages: [{ pageNo: 1, lines }] });
    expect(rejected[0].reason).toMatch(/2 SKU\(s\) but 1 invoice line/);
  });
});
