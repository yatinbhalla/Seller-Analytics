import * as XLSX from 'xlsx';
import { openDb } from '../src/server/db/db.js';
import { syncCatalog } from '../src/server/catalog/sync.js';

process.env.ANALYTICS_NO_FILE_STORE = '1';

/** A small catalog in the listers' own config shape, so tests never depend on F:\Claude. */
export const FIXTURE_PATHS = [
  {
    id: 'wall-hanging-organizer-black-floral-1p', name: 'Wall Hanging Organizer (black multicolour floral, 3 pockets, 10x30 in, pack of 1)',
    vertical: 'Hanging Organizers', skuPattern: 'WH_1MFO/{X}', meesho: { sellingPrice: '140' },
    variants: [{ key: 'pack1', label: 'Pack of 1 - 10 x 30 inch', skuPattern: 'WH_1MFO/{X}', packOf: '1', mrp: '399', sellingPrice: '199' }],
  },
  {
    id: 'wall-hanging-organizer-black-floral-2p', name: 'Wall Hanging Organizer (black multicolour floral, 3 pockets, 10x30 in, pack of 2)',
    vertical: 'Hanging Organizers', skuPattern: 'WH_MFO/{X}', meesho: { sellingPrice: '200' },
    variants: [{ key: 'pack2', label: 'Pack of 2 - 10 x 30 inch', skuPattern: 'WH_MFO/{X}', packOf: '2', mrp: '599', sellingPrice: '289' }],
  },
  {
    id: 'wall-hanging-organizer-black-floral-4p', name: 'Wall Hanging Organizer (black multicolour floral, 3 pockets, 10x30 in, pack of 4)',
    vertical: 'Hanging Organizers', skuPattern: 'WH_4MFO/{X}', meesho: { sellingPrice: '320' },
    variants: [{ key: 'pack4', label: 'Pack of 4 - 10 x 30 inch', skuPattern: 'WH_4MFO/{X}', packOf: '4', mrp: '899', sellingPrice: '429' }],
  },
  {
    id: 'wall-hanging-organizer-black-floral', name: 'Wall Hanging Organizer (black multicolour floral, 3 pockets, 10x30 in)',
    vertical: 'Hanging Organizers', skuPattern: 'WH_MFO_SET/{X}',
    variants: [
      { key: 'pack2', label: 'Pack of 2 - 10 x 30 inch', skuPattern: 'WH_MFO_SET/{X}', packOf: '2', mrp: '599', sellingPrice: '289' },
      { key: 'pack1', label: 'Pack of 1 - 10 x 30 inch', axis: 'Number of Holders', skuPattern: 'WH_MFO_SET_1/{X}', packOf: '1' },
      { key: 'pack4', label: 'Pack of 4 - 10 x 30 inch', axis: 'Number of Holders', skuPattern: 'WH_MFO_SET_4/{X}', packOf: '4' },
    ],
  },
  {
    id: 'pvc-table-cover', name: 'PVC Table Cover (transparent black, lace border)', vertical: 'Table Cover', skuPattern: 'TC_BT/{X}',
    meesho: { sellingPrice: '230' },
    variants: [
      { key: '40x60', label: '4 Seater — 40x60 inch', skuPattern: 'TC_BT/{X}', packOf: 1, mrp: '599', sellingPrice: '379' },
      { key: '60x90', label: '6 Seater — 60x90 inch', axis: 'Seating Capacity', skuPattern: 'TC_60*90_BT/{X}', packOf: 1, mrp: '899', sellingPrice: '499' },
    ],
  },
  {
    id: 'net-table-cover-brown-daisy', name: 'Net Table Cover (brown daisy floral, 40x60 in)', vertical: 'Table Cover', skuPattern: 'TC_NBC/{X}',
    variants: [{ key: '40x60', label: '4 Seater - 40x60 inch', skuPattern: 'TC_NBC/{X}', packOf: 1 }],
  },
];

/** Made-up cost prices for the fixture codes, so tests never depend on the seller's real cost sheet. */
export const TEST_COSTS = {
  WH_1MFO: 60, WH_MFO: 120, WH_4MFO: 240, WH_MFO_SET_1: 60, WH_MFO_SET: 120, WH_MFO_SET_4: 240,
  TC_BT: 150, 'TC_60*90_BT': 300, TC_NBC: 90,
};

export function makeDb({ withCatalog = true } = {}) {
  const db = openDb(':memory:');
  if (withCatalog) syncCatalog(db, { paths: FIXTURE_PATHS, ledgers: [{ source: 'test', skus: ['WH_MFO/40365', 'TC_BT/1.1'] }], costs: TEST_COSTS });
  return db;
}

/** An .xlsx file (as a Buffer) with the given sheets: { 'Sheet name': [[header…], [row…], …] }. */
export function xlsx(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function csv(rows) {
  return Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n'));
}

/**
 * A real, minimal PDF with one page per entry, each line drawn as text in Helvetica.
 * Enough for pdf.js to extract exactly these lines back.
 */
export function pdf(pages) {
  const objects = [];
  const add = (s) => objects.push(s) && objects.length;
  const catalogId = add(null);
  const pagesId = add(null);
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  for (const lines of pages) {
    const esc = (t) => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const stream = ['BT', '/F1 9 Tf', ...lines.map((l, i) => `1 0 0 1 30 ${800 - i * 14} Tm (${esc(l)}) Tj`), 'ET'].join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

// ─── Fixture reports in the marketplaces' column layouts ─────────────────────

export const MEESHO_PAY_HEAD = [
  'Sub Order No', 'Order Date', 'Dispatch Date', 'Product Name', 'Supplier SKU', 'Live Order Status', 'Quantity',
  'Transaction ID', 'Payment Date', 'Final Settlement Amount', 'Total Sale Amount (Incl. Shipping & GST)',
  'Total Sale Return Amount (Incl. Shipping & GST)', 'Meesho Commission (Incl. GST)', 'Shipping Charge (Incl. GST)',
  'Return Shipping Charge (Incl. GST)', 'TCS', 'TDS',
];

/** [subOrder, sku, status, sale, refund, commission, shipping, returnShip, tcs, tds, txn, paymentDate] → row with net computed. */
export function meeshoPayRow([sub, sku, status, sale, refund, comm, ship, rship, tcs, tds, txn = 'UTR1', pay = '2026-10-10']) {
  const net = Math.round((sale + refund + comm + ship + rship + tcs + tds) * 100) / 100;
  return [sub, '2026-10-01', '2026-10-02', 'Organizer', sku, status, 1, txn, pay, net, sale, refund, comm, ship, rship, tcs, tds];
}

export const MEESHO_RET_HEAD = [
  'Product Name', 'SKU', 'Qty', 'Order Number', 'Suborder Number', 'Return Created Date', 'Type of Return', 'Sub Type',
  'Status', 'Return Reason', 'Detailed Return Reason', 'Return Delivered Date',
];

export const FK_SETTLE_HEAD = [
  'NEFT ID', 'Payment Date', 'Bank Settlement Value (Rs.) = SUM(J:R)', 'Order ID', 'Order item ID', 'Sale Amount (Rs.)',
  'Refund (Rs.)', 'Commission (Rs.)', 'Fixed Fee  (Rs.)', 'Shipping Fee (Rs.)', 'Reverse Shipping Fee (Rs.)',
  'TCS (Rs.)', 'TDS (Rs.)', 'Seller SKU', 'Quantity', 'Shopsy Order',
];

export const FK_RET_HEAD = [
  'Order ID', 'Order Item ID', 'Return ID', 'Return Type', 'Return Status', 'Return Reason', 'Return Sub-reason',
  'Comments', 'SKU', 'Quantity', 'Return Requested Date', 'Return Completed Date',
];

/** Lines of a Flipkart label + invoice page. */
export function flipkartInvoiceLines({ orderId, invoiceNo = 'FAB1234567', date = '05-10-2026', items, shopsy = false }) {
  const grand = items.reduce((a, i) => a + i.total, 0);
  return [
    'Ship To: Ramesh, 12 MG Road, Pune, Maharashtra 411001',
    ...items.map((i, n) => `${n + 1} ${i.sku} | Organizer | ${i.qty}`),
    'Tax Invoice',
    `Order Id: ${orderId} Invoice Number # ${invoiceNo}`,
    `Order Date: ${date}, Invoice Date: ${date}`,
    shopsy ? 'Sold through Shopsy by Sample Brand' : 'Sold By: Sample Brand, Testpur, Haryana 110001',
    'Product Title Qty Gross Amount Discounts Taxable Value IGST Total',
    ...items.map((i) => `Wall organizer ${i.qty} ${(i.total).toFixed(2)} -0.00 ${(i.total / 1.18).toFixed(2)} ${(i.total - i.total / 1.18).toFixed(2)} ${i.total.toFixed(2)}`),
    'Shipping And Handling Charges 1 0.00 0.00 0.00 0.00 0.00',
    `Grand Total ₹ ${grand.toFixed(2)}`,
  ];
}

/** Lines of a Meesho label + invoice page. */
export function meeshoInvoiceLines({ items, invoiceNo = 'mso12345', date = '05.10.2026' }) {
  const orderNo = items[0].subOrder.split('_')[0];
  const grand = items.reduce((a, i) => a + i.total, 0);
  return [
    'Customer Address',
    'Sita Devi, 4 Lake View, Jaipur, Rajasthan 302001',
    'If undelivered, return to: Sample Brand, Testpur, Haryana 110001',
    'Product Details',
    'SKU Size Qty Color Order No.',
    ...items.map((i) => `${i.sku} Free Size ${i.qty} Black ${i.subOrder}`),
    'TAX INVOICE Original For Recipient',
    'Purchase Order No. Invoice No. Order Date Invoice Date',
    `${orderNo} ${invoiceNo} ${date} ${date}`,
    'Description HSN Qty Gross Amount Discount Taxable Value Taxes Total',
    ...items.map((i) => `Organizer - Free Size 6302 ${i.qty} Rs.${i.total.toFixed(2)} Rs.0.00 Rs.${(i.total / 1.12).toFixed(2)} IGST @12.0% Rs.${(i.total - i.total / 1.12).toFixed(2)} Rs.${i.total.toFixed(2)}`),
    `Total Rs.${(grand - grand / 1.12).toFixed(2)} Rs.${grand.toFixed(2)}`,
  ];
}
