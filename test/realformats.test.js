import { describe, expect, it } from 'vitest';
import { csv, makeDb, pdf, xlsx } from './helpers.js';
import { stageFiles } from '../src/server/importers/stage.js';
import { commitImports } from '../src/server/importers/commit.js';
import { humanReason } from '../src/server/importers/returnStatus.js';
import { overview, returnsReport } from '../src/server/metrics/reports.js';
import { loadLines } from '../src/server/metrics/lines.js';
import { stockReport } from '../src/server/inventory/ledger.js';

/**
 * The marketplaces' real layouts as found in the seller's files on 2026-10-22,
 * rebuilt with made-up buyers and orders. They keep the format handling covered
 * without any real customer data in the repository.
 */
async function importAll(db, files) {
  const staged = await stageFiles(db, files);
  const ids = staged.filter((s) => s.status === 'staged').map((s) => s.importId);
  if (ids.length) await commitImports(db, ids);
  return staged;
}

const FK_LABEL = (orderId = 'OD149610456974236033', sku = 'WH_MFO/75612') => [
  'STD E-Kart Logistics', 'E', `${orderId} PREPAID`, 'Ordered through', 'AWB No. FMPP4400116379', '(Z) LKO/RAJ',
  'Shipping/Customer address:', 'Name: Test Buyer,', '12 Example Street,', 'HBD: 21 - 10 Lucknow - 226017 , IN-UP', 'CPD: 27 - 10',
  'Sold By: SAMPLE TRADERS, Testpur - 110001', 'GSTIN: 06AAAAA0000A1ZX',
  'SKU ID | Description QTY', `1 ${sku} | Sample Brand Organizer, 1`, 'Microfiber Organizer',
  'Not for resale. Printed at 1146 hrs, 21/10/26',
  'Tax Invoice Order Id: Invoice No: GSTIN: 06AAAAA0000A1ZX', `${orderId} TESTFK4270000069 PAN: AAAAA0000A`,
  'Order Date: 21-10-2026, 10:23 AM Invoice Date: 21-10-2026, 10:35', 'AM',
  'Sold By Billing Address Shipping ADDRESS', 'Gross Taxable', 'Product Description Qty Discount IGST CESS Total', 'Amount Value',
  'Organizer (pack of 1 253.00 -0.00 240.95 12.05 0.00 253.00', `2) ${sku} Small |`,
  'Handling Fee 1 0.00 0 0.00 0.00 0.00 0.00', 'TOTAL PRICE: 253.00', 'TOTAL QTY: 1',
];

const MS_LABEL = ({ sku = 'TC_NBC/92281', sub = '414260587900711500_1', other = true } = {}) => [
  'Customer Address Prepaid: Do not collect cash', 'Test Buyer', 'Pickup 26/10', 'Nuh District, Haryana, 122107',
  'If undelivered, return to:', 'SAMPLE_TRADERS', 'TESTPUR, Haryana, 110001', 'VL3398975405668',
  'Product Details', 'SKU Size Qty Color Order No.', `${sku} Free Size 1 Cream ${sub}`,
  'TAX INVOICE Original For Recipient', 'BILL TO / SHIP TO Sold by : TEST SELLER',
  'Purchase Order No. Invoice No. Order Date Invoice Date', `${sub.split('_')[0]} abcde279446 19.10.2026 20.10.2026`,
  'Description HSN Qty Gross Amount Discount Taxable Value Taxes Total', 'Cream Lace Table Cover', 'SGST @2.5% :Rs.3.93',
  '40x60 Inch Swirl Pattern 630492 1 Rs.186.00 Rs.21.00 Rs.157.14 Rs.165.00', 'CGST @2.5% :Rs.3.93',
  ...(other ? ['Other Charges 630492 NA Rs.6.80 Rs.0 Rs.6.48 Rs.6.80'] : ['Other Charges 630492 NA Rs.0.00 Rs.0 Rs.0.00 Rs.0.00']),
  `Total Rs.8.18 Rs.${other ? '171.80' : '165.00'}`,
];

describe('Flipkart label PDF (real layout)', () => {
  it('reads invoice no, TOTAL PRICE, CESS column and the IN-UP state code', async () => {
    const db = makeDb();
    const [s] = await importAll(db, [{ buffer: pdf([FK_LABEL()]), fileName: 'invoice_labels.pdf' }]);
    expect(s.summary).toMatchObject({ kind: 'flipkart.invoices', new: 1, rejected: 0 });
    expect(db.prepare('SELECT * FROM orders').get()).toMatchObject({
      order_id: 'OD149610456974236033', invoice_no: 'TESTFK4270000069', invoice_date: '2026-10-21', code: 'WH_MFO', qty: 1,
      total_paise: 25300, taxable_paise: 24095, tax_paise: 1205, ship_state: 'Uttar Pradesh', ship_pincode: '226017',
    });
  });

  it('counts a reprinted label of the same order once', async () => {
    const db = makeDb();
    const [a, b] = await importAll(db, [
      { buffer: pdf([FK_LABEL()]), fileName: 'invoice_labels_1.pdf' },
      { buffer: pdf([[...FK_LABEL(), 'reprint']]), fileName: 'invoice_labels_2.pdf' },
    ]);
    expect(a.summary.new).toBe(1);
    expect(b.summary).toMatchObject({ new: 0, batchDupes: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM orders').get().n).toBe(1);
  });
});

describe('Meesho label PDF (real layout)', () => {
  it('reads a line whose tax wraps below it, and adds Other Charges to the invoice total', async () => {
    const db = makeDb();
    const [s] = await importAll(db, [{ buffer: pdf([MS_LABEL(), MS_LABEL({ sub: '414260587900711507_1', other: false })]), fileName: 'Sub_Order_Labels.pdf' }]);
    expect(s.summary).toMatchObject({ new: 2, rejected: 0 });
    const o = db.prepare("SELECT * FROM orders WHERE order_item_key = '414260587900711500_1'").get();
    expect(o).toMatchObject({ gross_paise: 18600, discount_paise: 2100, taxable_paise: 15714, total_paise: 16500, invoice_no: 'abcde279446', ship_state: 'Haryana' });
  });

  it('finds the invoice values when "Place of Supply" wraps under the headings', async () => {
    const db = makeDb();
    const wrap = (sub, inv) => MS_LABEL({ sub }).flatMap((l) =>
      l.startsWith('Purchase Order No.') ? [l, 'Place of Supply: Karnataka'] : l.startsWith(sub.split('_')[0]) ? [l.replace('abcde279446', inv)] : [l]);
    await importAll(db, [{ buffer: pdf([wrap('414977576238667477_1', 'abcde279439'), wrap('414230003847821607_1', 'abcde279481')]), fileName: 'labels.pdf' }]);
    const rows = db.prepare('SELECT invoice_no, invoice_date, order_date, shipment_key FROM orders ORDER BY invoice_no').all();
    expect(rows).toEqual([
      { invoice_no: 'abcde279439', invoice_date: '2026-10-20', order_date: '2026-10-19', shipment_key: 'inv:abcde279439' },
      { invoice_no: 'abcde279481', invoice_date: '2026-10-20', order_date: '2026-10-19', shipment_key: 'inv:abcde279481' },
    ]);
    // Two packets, two lots of ₹7.
    expect(overview(db, {}).total.packaging).toBe(1400);
  });
});

describe('Meesho payment file (real layout)', () => {
  const HEAD = ['Sub Order No', 'Order Date', 'Dispatch Date', 'Product Name', 'Supplier SKU', 'Catalog ID', 'Order source', 'Live Order Status',
    'Product GST %', 'Listing Price (Incl. taxes)', 'Quantity', 'Transaction ID', 'Payment Date', 'Final Settlement Amount', 'Price Type',
    'Total Sale Amount (Incl. Shipping & GST)', 'Total Sale Return Amount (Incl. Shipping & GST)', 'Fixed Fee (Incl. GST)', 'Warehousing fee (inc Gst)',
    'Return premium (incl GST)', 'Return premium (incl GST) of Return', 'Meesho Commission Percentage', 'Meesho Commission (Incl. GST)',
    'Meesho gold platform fee (Incl. GST)', 'Meesho mall platform fee (Incl. GST)', 'Fixed Fee (Incl. GST)', 'Warehousing fee (Incl. GST)',
    'Return Shipping Charge (Incl. GST)', 'GST Compensation (PRP Shipping)', 'Shipping Charge (Incl. GST)', 'Other Support Service Charges (Excl. GST)',
    'Waivers (Excl. GST)', 'Net Other Support Service Charges (Excl. GST)', 'GST on Net Other Support Service Charges', 'TCS', 'TDS Rate %', 'TDS',
    'Compensation', 'Claims', 'Recovery', 'Compensation Reason', 'Claims Reason', 'Recovery Reason'];
  const row = (o) => HEAD.map((h) => (h in o ? o[h] : '0.0'));
  // As in the real file: blank order columns, then formula letters.
  const FORMULA = HEAD.map((h, i) => (i < 6 ? null : h === 'Final Settlement Amount' ? '(B + C + G + H + I + L + Q + R + S + T + U + V + W + Y + AA + AD + AF + AX)' : h === 'Order source' ? 'Track which orders came from ads' : 'A'));
  const book = () => xlsx({
    Disclaimer: [['The amounts provided here are estimated figures']],
    'Order Payments': [['Order Related Details'], HEAD, FORMULA,
      row({ 'Sub Order No': '1001_1', 'Supplier SKU': 'WH_MFO/1', 'Live Order Status': 'Delivered', 'Order Date': '2026-10-01 20:47:23', 'Dispatch Date': '2026-10-02',
        'Product GST %': '5', Quantity: '1', 'Transaction ID': 'AXIS1', 'Payment Date': '2026-10-12', 'Final Settlement Amount': '158.35',
        'Total Sale Amount (Incl. Shipping & GST)': '209.0', 'Shipping Charge (Incl. GST)': '-49.45', TCS: '-1.0', TDS: '-0.2', 'Fixed Fee (Incl. GST)': '0.0' }),
      row({ 'Sub Order No': '1001_1', 'Supplier SKU': 'WH_MFO/1', 'Live Order Status': '', 'Transaction ID': 'AXIS2', 'Payment Date': '2026-10-13',
        'Final Settlement Amount': '-12.51', Recovery: '-12.51', 'Recovery Reason': 'Affiliate Fee' }),
      row({ 'Sub Order No': '1002_1', 'Supplier SKU': 'TC_BT/1', 'Live Order Status': 'RTO', 'Transaction ID': 'AXIS1', 'Payment Date': '2026-10-12',
        'Final Settlement Amount': '0.0', 'Total Sale Amount (Incl. Shipping & GST)': '110.0', 'Total Sale Return Amount (Incl. Shipping & GST)': '-110.0' }),
      row({ 'Sub Order No': '1003_1', 'Supplier SKU': 'TC_BT/2', 'Live Order Status': 'Return', 'Transaction ID': 'AXIS1', 'Payment Date': '2026-10-12',
        'Final Settlement Amount': '-157.0', 'Total Sale Amount (Incl. Shipping & GST)': '165.8', 'Total Sale Return Amount (Incl. Shipping & GST)': '-165.8',
        'Return Shipping Charge (Incl. GST)': '-157.0' }),
    ],
    'Ads Cost': [['Ads Cost'], ['Deduction Duration', 'Deduction Date', 'Campaign ID', 'Ad Cost', 'Credits / Waivers / Discounts', 'Ad Cost incl. Credits/Waivers/Discounts', 'GST', 'Total Ads Cost'],
      [null, null, null, 'A', 'B', '(A + B)'],
      ['2026-10-10', '2026-10-12', '26654559', '259.12', '0', '-259.12', '-46.64', '-305.76'],
      ['2026-10-09', '2026-10-12', '26654559', '301.87', '0', '-301.87', '-54.34', '-356.21']],
    'Referral Payments': [['Referral Payments'], ['Reward Id', 'Payment Date', 'Store Name', 'Reason', 'Net Referral Amount', 'Taxes (GST/TDS)'], [], ['No data is available for these dates.']],
  });

  it('skips the formula row, splits recoveries, RTOs, returns and ads, and adds up', async () => {
    const db = makeDb();
    const [s] = await importAll(db, [{ buffer: book(), fileName: 'payment.xlsx' }]);
    expect(s.summary).toMatchObject({ rejected: 0, new: 6 });
    const lines = db.prepare('SELECT order_item_key, txn_type, net_paise, penalty_paise, order_date, gst_pct FROM settlement_lines ORDER BY id').all();
    expect(lines.map((l) => [l.order_item_key, l.txn_type, l.net_paise])).toEqual([
      ['1001_1', 'sale', 15835], ['1001_1', 'adjustment', -1251], ['1002_1', 'rto', 0], ['1003_1', 'return', -15700],
      [null, 'ads', -30576], [null, 'ads', -35621],
    ]);
    expect(lines[0]).toMatchObject({ order_date: '2026-10-01', gst_pct: 5 });
  });

  it('reads an empty day ("No data is available") without setting anything aside', async () => {
    const db = makeDb();
    const empty = xlsx({
      'Order Payments': [['Order Related Details'], HEAD, FORMULA, ['No data is available for these dates.']],
      'Ads Cost': [['Ads Cost'], ['Deduction Duration', 'Deduction Date', 'Campaign ID', 'Ad Cost', 'Credits / Waivers / Discounts', 'Ad Cost incl. Credits/Waivers/Discounts', 'GST', 'Total Ads Cost'],
        [null, null, null, 'A', 'B', '(A + B)'], ['No data is available for these dates.']],
    });
    const [s] = await importAll(db, [{ buffer: empty, fileName: 'payment.xlsx' }]);
    expect(s.status).toBe('staged');
    expect(s.summary).toMatchObject({ kind: 'meesho.payments', new: 0, rejected: 0 });
  });

  it('imports the payment Excel straight from the Meesho .zip, and knows it is the same file', async () => {
    const { zipSync } = await import('fflate');
    const db = makeDb();
    const inner = book();
    const zip = Buffer.from(zipSync({ '1234567_SP_ORDER_ADS_REFERRAL_PAYMENT_FILE_PREVIOUS_PAYMENT_2026-10-21.xlsx': new Uint8Array(inner) }));
    const [s] = await importAll(db, [{ buffer: zip, fileName: 'meesho_PREVIOUS_PAYMENT_2026-10-21.zip' }]);
    expect(s).toMatchObject({ status: 'staged', fileName: '1234567_SP_ORDER_ADS_REFERRAL_PAYMENT_FILE_PREVIOUS_PAYMENT_2026-10-21.xlsx' });
    expect(s.summary).toMatchObject({ kind: 'meesho.payments', new: 6, rejected: 0 });
    // The same Excel, uploaded unzipped or in a second download of the zip, is refused as already imported.
    const again = await stageFiles(db, [{ buffer: inner, fileName: 'payment.xlsx' }, { buffer: zip, fileName: 'meesho_PREVIOUS_PAYMENT_2026-10-21 (1).zip' }]);
    expect(again.map((x) => x.status)).toEqual(['already_imported', 'already_imported']);
  });

  it('turns payment-only orders into lines: GST estimated, returns recognised, stock untouched', async () => {
    const db = makeDb();
    await importAll(db, [{ buffer: book(), fileName: 'payment.xlsx' }]);
    const lines = loadLines(db, {});
    const sale = lines.find((l) => l.order_item_key === '1001_1');
    expect(sale).toMatchObject({ line_source: 'payment', invoice_missing: 1, gst_estimated: 1, total_paise: 20900, sale_date: '2026-10-02' });
    expect(sale.tax_paise).toBe(Math.round((20900 * 5) / 105));
    expect(sale.settled_net).toBe(15835 - 1251);
    expect(lines.find((l) => l.order_item_key === '1002_1')).toMatchObject({ return_type: 'rto', return_status: 'closed' });
    expect(lines.find((l) => l.order_item_key === '1003_1')).toMatchObject({ return_type: 'customer' });
    expect(stockReport(db).every((s) => s.on_hand === 0)).toBe(true);
  });
});

describe('Flipkart settlement (real layout)', () => {
  const HEAD = ['NEFT ID', 'Neft Type', ' Payment Date', 'Bank Settlement Value (Rs.) \n= SUM(J:R)', 'Input GST + TCS Credits (Rs.)\n[GST+TCS]', 'Income Tax Credits (Rs.)\n[TDS]', null,
    'Order ID', 'Order item ID', 'Sale Amount (Rs.)', 'Total Offer Amount (Rs.)', 'My share (Rs.)', 'Customer Add-ons Amount (Rs.)', 'Marketplace Fee (Rs.)\n= SUM (V:AI)',
    'Taxes (Rs.)', 'Offer Adjustments (Rs.)', 'Protection Fund (Rs.)', 'Refund (Rs.)', null, 'Tier', 'Commission Rate (%)', 'Commission (Rs.)', 'Fixed Fee  (Rs.)',
    'Collection Fee (Rs.)', 'Pick And Pack Fee (Rs.)', 'Shipping Fee (Rs.)', 'Reverse Shipping Fee (Rs.)', 'TCS (Rs.)', 'TDS (Rs.)', 'GST on MP Fees (Rs.)',
    'Order Date', 'Dispatch Date', 'Seller SKU', 'Quantity', 'Return Type', 'Shopsy Order', 'Item Return Status', 'Invoice ID', 'Invoice Date', 'Sale Amount'];
  const r = (o) => HEAD.map((h) => (h in o ? o[h] : h && /\(Rs\.\)/.test(h) ? 0 : null));
  const neft = 'NFT-/XUTR/TESTUTR0000001X ';
  const book = (extra = {}) => xlsx({
    'Report Help': [[], ['Dear Seller,']],
    'Summary of report': [[null, 'Settlement Report Summary']],
    Orders: [['Payment Details'], HEAD, HEAD.map(() => null),
      r({ 'NEFT ID': neft, ' Payment Date': '2026-10-09', 'Bank Settlement Value (Rs.) \n= SUM(J:R)': 125.283, 'Order ID': 'OD1000000000000001', 'Order item ID': '1',
        'Sale Amount (Rs.)': 126, 'TCS (Rs.)': -0.6, 'TDS (Rs.)': -0.117, 'Seller SKU': 'WH_MFO/21', Quantity: 1, 'Shopsy Order': 'No', 'Order Date': '2026-09-26', 'Dispatch Date': '2026-09-28', 'Return Type': 'NA' }),
      r({ 'NEFT ID': neft, ' Payment Date': '2026-10-09', 'Bank Settlement Value (Rs.) \n= SUM(J:R)': 132.236, 'Order ID': 'OD1000000000000002', 'Order item ID': '2',
        'Sale Amount (Rs.)': 133, 'TCS (Rs.)': -0.637, 'TDS (Rs.)': -0.127, 'Seller SKU': 'TC_BT/1', Quantity: 1, 'Shopsy Order': 'Yes', 'Return Type': 'NA' }),
      r({ 'NEFT ID': neft, ' Payment Date': '2026-10-09', 'Bank Settlement Value (Rs.) \n= SUM(J:R)': 0, 'Order ID': 'OD1000000000000003', 'Order item ID': '3',
        'Sale Amount (Rs.)': 126, 'Refund (Rs.)': -126, 'Seller SKU': 'WH_1MFO/2', Quantity: 1, 'Return Type': 'Logistics Return', 'Item Return Status': 'Product Delivered' }),
    ],
    GST_Details: [['Transaction Summary'], ['Service Type', 'Neft Id'], ['Order Item', neft]],
    Fines: [['Payment Details'], ['NEFT ID', 'Payment Date', 'Settlement Value(Rs.) ', null, 'Transaction Name', 'Transaction Details', 'Transaction ID'],
      ...(extra.fine ? [[neft, '2026-10-09', -50, null, 'Fine', 'Late dispatch', 'F1']] : [])],
  });

  it('rounds each NEFT batch to what the bank paid, and splits RTO and Shopsy', async () => {
    const db = makeDb();
    const [s] = await importAll(db, [{ buffer: book(), fileName: 'payment (2).xlsx' }]);
    expect(s.summary).toMatchObject({ rejected: 0, new: 3 });
    // 125.283 + 132.236 + 0 = 257.519 → the bank paid ₹257.52.
    expect(db.prepare('SELECT SUM(net_paise) n FROM settlement_lines').get().n).toBe(25752);
    const rows = db.prepare('SELECT order_id, platform, txn_type, order_date FROM settlement_lines ORDER BY order_id').all();
    expect(rows).toEqual([
      { order_id: 'OD1000000000000001', platform: 'flipkart', txn_type: 'sale', order_date: '2026-09-26' },
      { order_id: 'OD1000000000000002', platform: 'shopsy', txn_type: 'sale', order_date: null },
      { order_id: 'OD1000000000000003', platform: 'flipkart', txn_type: 'rto', order_date: null },
    ]);
  });

  it('reads money on the other sheets as lines of their own', async () => {
    const db = makeDb();
    await importAll(db, [{ buffer: book({ fine: true }), fileName: 'payment.xlsx' }]);
    expect(db.prepare("SELECT txn_type, net_paise, penalty_paise FROM settlement_lines WHERE order_item_key IS NULL").all()).toEqual([
      { txn_type: 'fines', net_paise: -5000, penalty_paise: -5000 },
    ]);
  });
});

describe('returns files (real layouts)', () => {
  const MS_PRE = [[], ['Meesho Supplier Panel'], ['Supplier ID', '1'], ['Supplier Registered Name', 'TEST'], ['Supplier Email ID', 'x@example.com'], ['Download Date & Time Stamp', '0267530091333'], []];
  const MS_CREATED_HEAD = ['S No', 'Product Name', 'SKU', 'Variation', 'Meesho PID', 'Category', 'Qty', 'Order Number', 'Suborder Number', 'Dispatch Date', 'Return Created Date',
    'Type of Return', 'Sub Type', 'Expected Delivery Date', 'Courier Partner', 'AWB Number', 'Status', 'Attempt', 'Tracking Link', 'Return Price Type', 'Return Reason', 'Detailed Return Reason'];
  const MS_DONE_HEAD = ['S No', 'Product Name', 'SKU', 'Variation', 'Meesho PID', 'Category', 'Qty', 'Order Number', 'Suborder Number', 'Dispatch Date', 'Return Created Date',
    'Type of Return', 'Sub Type', 'Delivered Date', 'Courier Partner', 'AWB Number', 'Tracking Link', 'Proof of Delivery', 'Return Price Type', 'Return Reason', 'Detailed Return Reason', 'OTP verified at'];

  it('reads Meesho downloads below their supplier preamble, in UTF-8, and merges created → delivered', async () => {
    const db = makeDb();
    const created = csv([...MS_PRE, MS_CREATED_HEAD,
      ['1', 'Grey Organizer – Set of 2', 'WH_MFO/89168', 'Free Size', '', 'Wall Decor', '1', '417332817140655445', '417332817140655445_1', '2026-10-15', '2026-10-21',
        'Courier Return (RTO)', 'forward_RTO', '2026-11-29', 'PocketShip', 'VL1', 'Returned', 'null', 'https://example/track', '', 'NA', 'NA'],
      ['2', 'Table Cover', 'TC_BT/1', 'Free Size', '', 'Table', '1', '413482979911273220', '413482979911273220_1', '2026-10-11', '2026-10-15',
        'Customer Return', 'FIRST_RET', '2026-10-25', 'Valmo', 'VL2', 'Picked Up', 'NA', 'https://example/track', 'Meesho Price', 'Have size / fit related issues', 'Did not like the fit']]);
    const done = csv([...MS_PRE, MS_DONE_HEAD,
      ['1', 'Table Cover', 'TC_BT/1', 'Free Size', '', 'Table', '1', '413482979911273220', '413482979911273220_1', '2026-10-11', '2026-10-15',
        'Customer Return', 'FIRST_RET', '2026-10-21', 'Valmo', 'VL2', 'https://example/track', 'https://example/pod.pdf', 'Meesho Price', 'Have size / fit related issues', 'Did not like the fit', '2026-10-21 15:40:42']]);
    await importAll(db, [{ buffer: created, fileName: 'return created.csv' }, { buffer: done, fileName: 'completed_delivered.csv' }]);
    const rows = db.prepare('SELECT order_item_key, return_type, status, reason, closed_date, dispatch_date FROM returns ORDER BY order_item_key').all();
    expect(rows).toEqual([
      { order_item_key: '413482979911273220_1', return_type: 'customer', status: 'closed', reason: 'Have size / fit related issues', closed_date: '2026-10-21', dispatch_date: '2026-10-11' },
      // "Returned" in the created file means the RTO parcel is on its way back.
      { order_item_key: '417332817140655445_1', return_type: 'rto', status: 'open', reason: null, closed_date: null, dispatch_date: '2026-10-15' },
    ]);
  });

  it('reads Flipkart Completion Status and makes reason codes readable', async () => {
    const db = makeDb();
    const HEAD = ['Location ID', 'Order ID', 'Order Item ID', 'Return ID', 'Tracking ID', 'Shipment ID', 'Replacement Order Item ID', 'SKU', 'FSN', 'Product', 'Total Price', 'Quantity',
      'FF Type', 'Return Requested Date', 'Return Approval Date', 'Completed Date', 'Out For Delivery Date', 'Return Delivery Promise Date', 'Picked Up Date', 'Shipment Type',
      'Return Status', 'Completion Status', 'Return Type', 'Return Reason', 'Return Sub-reason', 'Comments'];
    const file = csv([HEAD,
      ['L', 'OD449979080188593033', '449979080188593033', '07496041703025139774399513', 'T', 'S', '', 'BM_W_BR_LN/59792', 'F', 'Dohar', '291.0', '1', 'NON_FBF',
        '12 October, 2026', '12 October, 2026', '20 October, 2026', '20 October, 2026', '28 October, 2026', '', 'NORMAL', 'delivered', 'Closed', 'customer_return', 'QUALITY_ISSUE', 'QUALITY_NOT_AS_EXPECTED', 'Poor quality'],
      ['L', 'OD449632539007781033', '449632539007781033', '03409471003026868706243147', 'T', 'S', '', 'WH_MFO/1', 'F', 'Organizer', '159.0', '1', 'NON_FBF',
        '21 October, 2026', '21 October, 2026', '', '', '', '', 'NORMAL', 'in_transit', 'Open', 'courier_return', 'ORC_validated with customer', 'ORC_validated with customer', '']]);
    await importAll(db, [{ buffer: file, fileName: 'all return.csv' }]);
    expect(db.prepare('SELECT status, outcome, return_type, reason, sub_reason, price_paise, created_date FROM returns ORDER BY created_date').all()).toEqual([
      { status: 'closed', outcome: 'received', return_type: 'customer', reason: 'Quality issue', sub_reason: 'Quality not as expected', price_paise: 29100, created_date: '2026-10-12' },
      { status: 'open', outcome: null, return_type: 'rto', reason: 'ORC validated with customer', sub_reason: 'ORC validated with customer', price_paise: 15900, created_date: '2026-10-21' },
    ]);
    expect(humanReason('SIZE_FIT_ISSUES')).toBe('Size fit issues');
    expect(humanReason("Don't need the product anymore")).toBe("Don't need the product anymore");
  });

  it('counts returns of sales before the history in reasons, not in money or return rates', async () => {
    const db = makeDb();
    const HEAD = ['Order ID', 'Order Item ID', 'Return ID', 'SKU', 'Total Price', 'Quantity', 'Return Requested Date', 'Completed Date', 'Return Status', 'Completion Status', 'Return Type', 'Return Reason'];
    await importAll(db, [{ buffer: csv([HEAD, ['OD7333333333333330', '1', 'R1', 'WH_MFO/1', '159.0', '1', '20 October, 2026', '', 'in_transit', 'Open', 'customer_return', 'QUALITY_ISSUE']]), fileName: 'r.csv' }]);
    const o = overview(db, {}).total;
    expect(o).toMatchObject({ lines: 0, gmv: 0, returnsCustomer: 1, returnsBeforeHistory: 1, returnCost: 0, returnRate: 0 });
    expect(returnsReport(db, {}).reasons[0]).toMatchObject({ reason: 'Quality issue', total: 1 });
  });
});

describe('Flipkart cancelled orders (real layout)', () => {
  const HEAD = ['Order Cancellation Date', 'Order Approval Date', 'Order ID', 'Order Item ID', 'Logistics Return', 'Cancellation Type', 'Reason', 'Sub Reason',
    'FSN', 'SKU', 'Product Description', 'HAS OFFER', 'Quantity', 'Shipping', 'Value', 'Total', 'Payment Type', 'Address Name', 'Address Line 1',
    'Address Line 2', 'City', 'State', 'PIN Code', 'Invoice Number'];
  const row = (orderId, sku, logisticsReturn, total) => ['Oct 21, 2026 23:51:27', 'Oct 21, 2026 10:23:00', orderId, `'${orderId.slice(2)}`, logisticsReturn,
    'Cancelled by market place', 'Shipment Eob Ageing ', 'Shipment Eob Ageing ', 'F', sku, 'Organizer', 'N.A', '1', '0', '79', total, 'cod',
    'Test Buyer', '12 Example Street', '', 'Lucknow', 'Uttar Pradesh', '226017', 'TESTFK4270000069'];
  const CANCELLED = csv([HEAD,
    row('OD149610456974236033', 'WH_MFO/75612', 'No', '178'),
    row('OD149908039244580033', 'WH_MFO/28617', 'Yes', '178')]);

  it('cancels an invoiced line before dispatch, keeps its invoice money, and skips courier returns', async () => {
    const db = makeDb();
    await importAll(db, [{ buffer: pdf([FK_LABEL()]), fileName: 'invoice_labels.pdf' }]);
    expect(overview(db, {}).total.lines).toBe(1);

    const [s] = await importAll(db, [{ buffer: CANCELLED, fileName: 'Cancelled-Orders.csv' }]);
    expect(s.summary).toMatchObject({ kind: 'flipkart.cancellations', new: 0, update: 1, money_changed: 0, rejected: 0, skipped: 1 });
    expect(db.prepare('SELECT cancelled, total_paise, taxable_paise FROM orders').get()).toEqual({ cancelled: 1, total_paise: 25300, taxable_paise: 24095 });
    // Out of sales, stock and packaging; the courier return was not made into a second return.
    expect(overview(db, {}).total.lines).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM returns').get().n).toBe(0);

    // A reprinted label of the cancelled order does not bring it back.
    const [again] = await importAll(db, [{ buffer: pdf([[...FK_LABEL(), 'reprint']]), fileName: 'invoice_labels_2.pdf' }]);
    expect(again.summary.unchanged).toBe(1);
    expect(db.prepare('SELECT cancelled FROM orders').get().cancelled).toBe(1);
  });

  it('is told apart from the returns report, and merges with the invoice in the same upload', async () => {
    const db = makeDb();
    const [inv, can] = await importAll(db, [
      { buffer: pdf([FK_LABEL()]), fileName: 'invoice_labels.pdf' },
      { buffer: CANCELLED, fileName: 'Cancelled-Orders.csv' },
    ]);
    expect(inv.summary.new).toBe(1);
    expect(can.summary).toMatchObject({ kind: 'flipkart.cancellations', batchDupes: 1, skipped: 1 });
    expect(db.prepare('SELECT cancelled, total_paise FROM orders').all()).toEqual([{ cancelled: 1, total_paise: 25300 }]);
  });

  it('records a cancellation that arrives before any invoice, with its buyer', async () => {
    const db = makeDb();
    await importAll(db, [{ buffer: CANCELLED, fileName: 'Cancelled-Orders.csv' }]);
    const o = db.prepare('SELECT * FROM orders').get();
    expect(o).toMatchObject({
      cancelled: 1, code: 'WH_MFO', qty: 1, total_paise: 17800, order_date: '2026-10-21', ship_state: 'Uttar Pradesh', ship_pincode: '226017',
      buyer_name: 'Test Buyer', buyer_key: 'test buyer|226017', ship_address: '12 Example Street', ship_city: 'Lucknow', payment_mode: 'cod',
    });
  });
});

describe('Orders reports (real layouts)', () => {
  const MS_HEAD = ['Reason for Credit Entry', 'Sub Order No', 'Catalog ID', 'Order Date', 'Order source', 'Customer State', 'Product Name', 'SKU', 'Size',
    'Quantity', 'Supplier Listed Price (Incl. GST + Commission)', 'Supplier Discounted Price (Incl GST and Commision)', 'Packet Id'];
  const msRow = (status, sub, sku, packet = 'KP4TEST0001', price = '165.0', qty = '1') =>
    [status, sub, '514535947', '2026-10-19', '', 'Haryana', 'Table Cover', sku, 'Free Size', qty, price, price, packet];
  const msOrders = (rows) => csv([MS_HEAD, ...rows]);

  const FK_HEAD = ['order_item_id', 'order_id', 'fulfilment_source', 'fulfilment_type', 'order_date', 'order_approval_date', 'order_item_status', 'sku',
    'fsn', 'product_title', 'quantity', 'order_cancellation_date', 'return_id', 'dispatched_date', 'order_delivery_date'];
  const fkRow = (o) => FK_HEAD.map((h) => o[h] ?? '');
  const fkOrders = (rows) => xlsx({ Help: [['How to read this report']], Orders: [FK_HEAD, ...rows.map(fkRow)] });

  it('reads the Meesho orders report: cancelled lines, packets, GST estimated', async () => {
    const db = makeDb();
    const [s] = await importAll(db, [{
      buffer: msOrders([
        msRow('DELIVERED', '1001_1', 'WH_MFO/1', 'KP4A'), msRow('DELIVERED', '1001_2', 'TC_BT/1', 'KP4A'),
        msRow('CANCELLED', '1002_1', 'TC_BT/2', ''), msRow('SHIPPED', '1003_1', 'WH_MFO/3', 'KP4B', '120.0', '2'),
      ]),
      fileName: 'Orders_2026-09-22_2026-10-21_2026-10-23_1_42-1_47_1234567.csv',
    }]);
    expect(s.summary).toMatchObject({ kind: 'meesho.orders', new: 4, rejected: 0, dateFrom: '2026-10-19' });
    const rows = db.prepare('SELECT order_item_key, shipment_key, cancelled, total_paise, qty, source FROM orders ORDER BY order_item_key').all();
    expect(rows).toEqual([
      { order_item_key: '1001_1', shipment_key: 'pkt:KP4A', cancelled: 0, total_paise: 16500, qty: 1, source: 'order_report' },
      { order_item_key: '1001_2', shipment_key: 'pkt:KP4A', cancelled: 0, total_paise: 16500, qty: 1, source: 'order_report' },
      { order_item_key: '1002_1', shipment_key: 'sub:1002_1', cancelled: 1, total_paise: 16500, qty: 1, source: 'order_report' },
      { order_item_key: '1003_1', shipment_key: 'pkt:KP4B', cancelled: 0, total_paise: 24000, qty: 2, source: 'order_report' },
    ]);
    const lines = loadLines(db, {});
    expect(lines.map((l) => l.order_item_key).sort()).toEqual(['1001_1', '1001_2', '1003_1']);
    expect(lines.find((l) => l.order_item_key === '1001_1')).toMatchObject({ line_source: 'order', invoice_missing: 1, gst_estimated: 1, total_paise: 16500 });
    // Two packets, two lots of ₹7.
    expect(overview(db, {}).total.packaging).toBe(1400);
  });

  it('never lets an orders report overwrite an invoice, and lets a later invoice replace it without a money check', async () => {
    const label = { buffer: pdf([MS_LABEL()]), fileName: 'Sub_Order_Labels.pdf' };
    const report = { buffer: msOrders([msRow('DELIVERED', '414260587900711500_1', 'TC_NBC/92281', 'KP4X', '170.0')]), fileName: 'Orders.csv' };
    const invoiced = { invoice_no: 'abcde279446', total_paise: 16500, taxable_paise: 15714, source: null };

    // Invoice first, then the report: the invoice's figures stay.
    const a = makeDb();
    await importAll(a, [label]);
    const [r] = await importAll(a, [report]);
    expect(r.summary).toMatchObject({ rejected: 0, money_changed: 0 });
    expect(a.prepare('SELECT invoice_no, total_paise, taxable_paise, source FROM orders').get()).toEqual(invoiced);

    // Report first, then the invoice: it replaces the report line, nothing to confirm.
    const b = makeDb();
    await importAll(b, [report]);
    const [i] = await importAll(b, [label]);
    expect(i.summary).toMatchObject({ rejected: 0, money_changed: 0, update: 1 });
    expect(b.prepare('SELECT invoice_no, total_paise, taxable_paise, source FROM orders').get()).toEqual(invoiced);

    // Both in one upload, either way round.
    for (const files of [[label, report], [report, label]]) {
      const c = makeDb();
      const staged = await importAll(c, files);
      expect(staged.every((x) => x.summary.rejected === 0)).toBe(true);
      expect(c.prepare('SELECT invoice_no, total_paise, source FROM orders').all()).toEqual([{ invoice_no: 'abcde279446', total_paise: 16500, source: null }]);
    }
  });

  it('cancels an invoiced line the report says was cancelled', async () => {
    const db = makeDb();
    await importAll(db, [{ buffer: pdf([MS_LABEL()]), fileName: 'labels.pdf' }]);
    await importAll(db, [{ buffer: msOrders([msRow('CANCELLED', '414260587900711500_1', 'TC_NBC/92281', '')]), fileName: 'Orders.csv' }]);
    expect(db.prepare('SELECT cancelled, invoice_no, total_paise FROM orders').get()).toEqual({ cancelled: 1, invoice_no: 'abcde279446', total_paise: 16500 });
  });

  it('reads the Flipkart orders report: wrapped SKUs, repeated items, no price, cancelled only before dispatch', async () => {
    const db = makeDb();
    const [s] = await importAll(db, [{
      buffer: fkOrders([
        { order_item_id: 'OI:1', order_id: 'OD1', order_date: '2026-10-20 22:45:37', order_item_status: 'DELIVERED', sku: '"""SKU:WH_MFO/1"""', quantity: '1', dispatched_date: '2026-10-21' },
        { order_item_id: 'OI:4', order_id: 'OD1', order_date: '2026-10-20 22:45:37', order_item_status: 'DELIVERED', sku: '"""SKU:WH_MFO/1"""', quantity: '2', dispatched_date: '2026-10-21' },
        { order_item_id: '2', order_id: 'OD2', order_date: '2026-10-20', order_item_status: 'CANCELLED', sku: 'TC_BT/1', quantity: '1', order_cancellation_date: '2026-10-20' },
        { order_item_id: '3', order_id: 'OD3', order_date: '2026-10-20', order_item_status: 'CANCELLED', sku: 'TC_BT/1', quantity: '1',
          order_cancellation_date: '2026-10-23', dispatched_date: '2026-10-21' },
      ]),
      fileName: 'd210fb41-8b8e-4ce8-b4ed-82b8c1698850_1792700006000.xlsx',
    }]);
    expect(s.summary).toMatchObject({ kind: 'flipkart.orders', new: 3, rejected: 0 });
    expect(db.prepare('SELECT order_item_key, code, qty, order_date, cancelled, total_paise FROM orders ORDER BY order_id').all()).toEqual([
      { order_item_key: 'OD1:WH_MFO/1', code: 'WH_MFO', qty: 3, order_date: '2026-10-20', cancelled: 0, total_paise: 0 },
      { order_item_key: 'OD2:TC_BT/1', code: 'TC_BT', qty: 1, order_date: '2026-10-20', cancelled: 1, total_paise: 0 },
      { order_item_key: 'OD3:TC_BT/1', code: 'TC_BT', qty: 1, order_date: '2026-10-20', cancelled: 0, total_paise: 0 },
    ]);
    // With no payment yet, the price falls back to the list price.
    expect(loadLines(db, {}).find((l) => l.order_item_key === 'OD1:WH_MFO/1')).toMatchObject({ line_source: 'order', price_estimated: 1, total_paise: 3 * 28900 });
  });

  it('reads an empty Flipkart orders report as nothing to import', async () => {
    const db = makeDb();
    const [s] = await importAll(db, [{ buffer: fkOrders([]), fileName: 'orders.xlsx' }]);
    expect(s).toMatchObject({ status: 'staged', summary: { kind: 'flipkart.orders', new: 0, rejected: 0 } });
  });
});
