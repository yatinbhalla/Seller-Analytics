import { excelImporter } from '../excelImporter.js';
import { mapRows, field, required, soft } from '../table.js';
import { date, headerKey, id, int, isBlank, paise, text } from '../../lib/parse.js';
import { parseSku } from '../../catalog/sku.js';
import { orderItemKey } from '../keys.js';

/**
 * Flipkart settlement report (Seller Hub → Payments → Settlements → download), checked
 * against a real file on 2026-10-22. Covers Flipkart and Shopsy; "Shopsy Order" tells
 * them apart.
 *
 * "Orders" sheet: a group-heading row, the header row (headers contain line breaks:
 * "Bank Settlement Value (Rs.) \n= SUM(J:R)"), then a sub-header row for the buyer
 * columns, then data. Fees are negative. "Marketplace Fee" is the sum of the
 * individual fee columns and "Taxes" the sum of TCS, TDS and GST on fees, so only
 * the individual columns are read; GST on fees and offer adjustments land in
 * other_paise, which keeps every line's parts equal to Bank Settlement Value.
 *
 * Every other sheet that pays or charges money — MP Fee Rebate, Non_Order_SPF,
 * Storage_Recall, Fines, Ads, the services sheets, TCS_Recovery, TDS — is read
 * generically: one line per row with a settlement value, so the bank total of the
 * whole file reconciles.
 */
const spec = {
  required: ['orderId', 'settlementValue', 'sku'],
  columns: {
    neftId: ['NEFT ID', 'Settlement Ref No', 'UTR', 'Settlement ID'],
    neftType: ['Neft Type'],
    paymentDate: ['Payment Date', 'Settlement Date'],
    settlementValue: ['Bank Settlement Value (Rs.) = SUM(J:R)', 'Bank Settlement Value', 'Settlement Value', 'Net Settlement Value'],
    orderId: ['Order ID', 'Order Id'],
    orderItemId: ['Order item ID', 'Order Item ID'],
    saleAmount: ['Sale Amount (Rs.)', 'Sale Amount'],
    totalOffer: ['Total Offer Amount (Rs.)', 'Total Offer Amount'],
    myShare: ['My share (Rs.)', 'My Share'],
    refund: ['Refund (Rs.)', 'Refund'],
    protectionFund: ['Protection Fund (Rs.)', 'Protection Fund'],
    commission: ['Commission (Rs.)', 'Commission'],
    fixedFee: ['Fixed Fee  (Rs.)', 'Fixed Fee'],
    collectionFee: ['Collection Fee (Rs.)', 'Collection Fee'],
    pickPackFee: ['Pick And Pack Fee (Rs.)', 'Pick And Pack Fee'],
    shippingFee: ['Shipping Fee (Rs.)', 'Shipping Fee'],
    reverseShippingFee: ['Reverse Shipping Fee (Rs.)', 'Reverse Shipping Fee'],
    shopsyMarketingFee: ['Shopsy Marketing Fee (Rs.)', 'Shopsy Marketing Fee'],
    cancellationFee: ['Product Cancellation Fee (Rs.)', 'Product Cancellation Fee'],
    tcs: ['TCS (Rs.)', 'TCS'],
    tds: ['TDS (Rs.)', 'TDS'],
    gstOnFees: ['GST on MP Fees (Rs.)', 'GST on MP Fees'],
    sku: ['Seller SKU', 'SKU'],
    qty: ['Quantity', 'Qty'],
    orderDate: ['Order Date'],
    dispatchDate: ['Dispatch Date'],
    returnType: ['Return Type'],
    itemReturnStatus: ['Item Return Status'],
    shopsy: ['Shopsy Order'],
    invoiceId: ['Invoice ID'],
    invoiceDate: ['Invoice Date'],
    shippingZone: ['Shipping Zone'],
  },
};

const m = (get, name) => field(name, paise, get(name)) ?? 0;

export default excelImporter({
  kind: 'flipkart.settlement',
  platform: 'flipkart',
  entity: 'settlement',
  label: 'Flipkart settlement report',
  spec,
  row(get) {
    const orderId = field('Order ID', id, get('orderId'));
    // The buyer sub-header row and blank rows between NEFT batches carry no order.
    if (!orderId) return null;
    const net = required('Bank Settlement Value', field('Bank Settlement Value', paise, get('settlementValue')));
    const parsed = parseSku(required('Seller SKU', text(get('sku'))));
    const neftId = field('NEFT ID', id, get('neftId'));
    const paymentDate = field('Payment Date', date, get('paymentDate'));
    const returnType = text(get('returnType'));
    const returnStatus = text(get('itemReturnStatus'));

    const sale = m(get, 'saleAmount') + m(get, 'totalOffer') + m(get, 'myShare');
    const refund = m(get, 'refund');
    const commission = m(get, 'commission') + m(get, 'shopsyMarketingFee');
    const fixedFee = m(get, 'fixedFee') + m(get, 'pickPackFee');
    const shipping = m(get, 'shippingFee');
    const reverseShip = m(get, 'reverseShippingFee');
    const collection = m(get, 'collectionFee');
    const tcs = m(get, 'tcs');
    const tds = m(get, 'tds');
    const taxWithheld = tcs + tds;
    const penalty = m(get, 'cancellationFee');
    const claim = m(get, 'protectionFund');
    const known = sale + refund + commission + fixedFee + shipping + reverseShip + collection + taxWithheld + penalty + claim;

    const itemKey = orderItemKey('flipkart', { orderId, sku: parsed.sku });
    // 'Logistics Return' is Flipkart's name for an RTO.
    const isReturn = refund !== 0 || reverseShip !== 0 || /return/i.test(returnType || '');
    const txnType = !isReturn ? 'sale' : /logistic|courier|rto/i.test(returnType || '') ? 'rto' : 'return';
    const orderItemId = field('Order item ID', id, get('orderItemId'));
    return {
      entity: 'settlement',
      rawNet: Number(get('settlementValue')),
      known,
      batch: neftId || paymentDate || '',
      key: `${itemKey}|${orderItemId || ''}|${neftId || paymentDate || ''}|${txnType}`,
      payload: {
        platform: /^(yes|true|y|1)$/i.test(text(get('shopsy')) || '') ? 'shopsy' : 'flipkart',
        order_item_key: itemKey,
        order_id: orderId,
        sku: parsed.sku,
        code: parsed.code,
        txn_type: txnType,
        payment_date: paymentDate,
        settlement_ref: neftId,
        sale_paise: sale,
        refund_paise: refund,
        commission_paise: commission,
        fixed_fee_paise: fixedFee,
        shipping_paise: shipping,
        reverse_ship_paise: reverseShip,
        collection_paise: collection,
        tax_withheld_paise: taxWithheld,
        tcs_paise: tcs,
        tds_paise: tds,
        penalty_paise: penalty,
        claim_paise: claim,
        ads_paise: 0,
        other_paise: net - known,
        net_paise: net,
        order_date: soft(date, get('orderDate')),
        dispatch_date: soft(date, get('dispatchDate')),
        qty: field('Quantity', int, get('qty')),
        gst_pct: null,
        invoice_no: soft(id, get('invoiceId')),
        invoice_date: soft(date, get('invoiceDate')),
        shipping_zone: text(get('shippingZone')),
        breakdown_json: JSON.stringify({
          orderItemId,
          neftType: text(get('neftType')),
          gstOnFeesPaise: m(get, 'gstOnFees'),
          returnType,
          returnStatus,
        }),
      },
    };
  },
  finish: roundPerNeft,
  extraTables: ({ sheets }) => otherSheets(sheets),
});

/**
 * Flipkart works in fractions of a paisa (₹178.972 on a line, from 0.1% TCS) and pays
 * each NEFT batch as the rounded sum. Rounding every line on its own drifts — 6 paise
 * over one real file. So within each batch the lines are rounded down and the
 * leftover paise go to the lines with the largest remainders, which makes the batch
 * add up to exactly what reached the bank. The same batch always rounds the same way,
 * so a re-upload still matches line for line.
 */
function roundPerNeft(rows) {
  const batches = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.rawNet)) continue;
    if (!batches.has(r.batch)) batches.set(r.batch, []);
    batches.get(r.batch).push(r);
  }
  for (const list of batches.values()) {
    const milli = list.map((r) => Math.round(r.rawNet * 100000)); // 1/1000 paisa
    const target = Math.round(milli.reduce((a, b) => a + b, 0) / 1000);
    const floors = milli.map((v) => Math.floor(v / 1000));
    let left = target - floors.reduce((a, b) => a + b, 0);
    const order = list
      .map((r, i) => ({ i, rem: milli[i] - floors[i] * 1000, key: r.key }))
      .sort((a, b) => b.rem - a.rem || a.key.localeCompare(b.key));
    for (const { i } of order) {
      const r = list[i];
      const net = floors[i] + (left > 0 ? 1 : 0);
      if (left > 0) left--;
      r.payload.net_paise = net;
      r.payload.other_paise = net - r.known;
    }
  }
  for (const r of rows) {
    delete r.rawNet;
    delete r.known;
    delete r.batch;
  }
}

/** Sheets that hold no money lines of their own. */
const SKIP_SHEETS = /^(orders|report help|summary of report|gst_details)$/i;

/** Sheet name → how its money shows in the P&L. */
function kindOf(sheet) {
  if (/ads/i.test(sheet)) return { txnType: 'ads', column: 'ads_paise' };
  if (/fine/i.test(sheet)) return { txnType: 'fines', column: 'penalty_paise' };
  if (/rebate/i.test(sheet)) return { txnType: 'rebate', column: 'other_paise' };
  if (/spf/i.test(sheet)) return { txnType: 'claim', column: 'claim_paise' };
  // TCS_Recovery: TCS on an order returned later, taken back. TDS: TDS claims settled.
  if (/tcs/i.test(sheet)) return { txnType: 'tcs', column: 'tax_withheld_paise', part: 'tcs_paise' };
  if (/tds/i.test(sheet)) return { txnType: 'tds', column: 'tax_withheld_paise', part: 'tds_paise' };
  return { txnType: sheet.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), column: 'other_paise' };
}

/**
 * Every non-Orders sheet: find its header (it has a NEFT ID and a "Settlement Value"
 * column, spelt a few ways), and turn each row with a value into a line. A row that
 * names an order (MP Fee Rebate) is tied to it; the rest belong to no order.
 */
function otherSheets(sheets) {
  const rows = [];
  const rejected = [];
  for (const sheet of sheets) {
    if (SKIP_SHEETS.test(sheet.name.trim())) continue;
    let headerRow = -1;
    let col = null;
    for (let r = 0; r < Math.min(sheet.rows.length, 10); r++) {
      // Array.from, not .map: dense-mode rows can have holes, which .map keeps as holes.
      const keys = Array.from(sheet.rows[r] || [], headerKey);
      const value = keys.findIndex((k) => k.startsWith('settlementvalue'));
      const neft = keys.indexOf('neftid');
      if (value !== -1 && neft !== -1) {
        headerRow = r;
        col = {
          value, neft,
          date: ['paymentdate', 'purchasedate', 'transactiondate', 'claimdate', 'rebateprocessingdate']
            .map((k) => keys.indexOf(k))
            .find((i) => i !== -1) ?? -1,
          orderId: keys.indexOf('orderid'),
          sku: keys.findIndex((k) => k === 'sku' || k === 'sellersku'),
          ref: keys.findIndex((k, i) => i !== neft && i !== keys.indexOf('orderid') && /id$/.test(k)),
        };
        break;
      }
    }
    if (headerRow === -1) continue;
    const { txnType, column, part } = kindOf(sheet.name.trim());
    const table = { sheet, headerRow, col: {} };
    const res = mapRows(table, (_, rowNo) => {
      const cells = sheet.rows[rowNo - 1];
      if (isBlank(cells[col.value])) return null;
      const amount = field('Settlement Value', paise, cells[col.value]);
      if (amount == null || amount === 0) return null;
      const neftId = field('NEFT ID', id, cells[col.neft]);
      const when = col.date !== -1 ? field('Payment Date', date, cells[col.date]) : null;
      const ref = col.ref !== -1 ? field('ID', id, cells[col.ref]) : null;
      const orderId = col.orderId !== -1 ? field('Order ID', id, cells[col.orderId]) : null;
      const parsed = col.sku !== -1 ? parseSku(cells[col.sku]) : null;
      const itemKey = orderId && parsed ? orderItemKey('flipkart', { orderId, sku: parsed.sku }) : null;
      const money = {
        sale_paise: 0, refund_paise: 0, commission_paise: 0, fixed_fee_paise: 0, shipping_paise: 0, reverse_ship_paise: 0,
        collection_paise: 0, tax_withheld_paise: 0, tcs_paise: 0, tds_paise: 0, penalty_paise: 0, claim_paise: 0, ads_paise: 0, other_paise: 0,
      };
      money[column] = amount;
      if (part) money[part] = amount;
      return {
        entity: 'settlement',
        key: `${txnType}|${neftId || ''}|${itemKey || ref || ''}|${when || ''}|${amount}`,
        payload: {
          platform: 'flipkart', order_item_key: itemKey, order_id: orderId, sku: parsed?.sku ?? null, code: parsed?.code ?? null,
          txn_type: txnType, payment_date: when, settlement_ref: neftId, ...money, net_paise: amount,
          order_date: null, dispatch_date: null, qty: null, gst_pct: null, invoice_no: null, invoice_date: null,
          breakdown_json: JSON.stringify({ sheet: sheet.name.trim(), ref }),
        },
      };
    });
    for (const r of [...res.rows, ...res.rejected]) r.rowNo = `${sheet.name.trim()}!${r.rowNo}`;
    rows.push(...res.rows);
    rejected.push(...res.rejected);
  }
  return { rows, rejected };
}
