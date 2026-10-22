import { CellError, paise } from '../../lib/parse.js';
import { parseSku } from '../../catalog/sku.js';
import { orderItemKey } from '../keys.js';
import { dateFrom, findSkus, firstMatch, itemFromLine, shipTo, validateInvoice } from '../invoiceText.js';

/**
 * Meesho label + tax invoice PDF (Supplier Panel → Orders → download label).
 *
 * Each page: the shipping label with a "Product Details" table (SKU, size, qty,
 * colour, sub-order no), then the tax invoice. Checked against a real 59-page label PDF
 * on 2026-10-22: the item row's tax amount wraps onto the line below ("Rs.12.62"), so
 * the row reads Qty, Gross, Discount, Taxable, Total, and an "Other Charges" row
 * (logistics fee, qty "NA") is added to the invoice total. A page that does not read
 * cleanly is quarantined with its reason — never guessed.
 */
const SUB_ORDER = /\b(\d{10,22}_\d{1,3})\b/;
const SUB_ORDER_ID = /^\d{10,22}_\d{1,3}$/;

export default {
  kind: 'meesho.invoices',
  platform: 'meesho',
  entity: 'order',
  label: 'Meesho invoice PDF',
  accepts: 'pdf',
  detect({ pages }) {
    const text = pages.slice(0, 3).map((p) => p.lines.join('\n')).join('\n');
    if (!/tax\s*invoice/i.test(text)) return null;
    const hits = (SUB_ORDER.test(text) ? 2 : 0) + (/meesho/i.test(text) ? 1 : 0);
    return hits >= 2 ? { status: 'match', score: hits } : null;
  },
  parse({ pages }) {
    const rows = [];
    const rejected = [];
    for (const page of pages) {
      const ref = `page ${page.pageNo}`;
      if (!page.lines.length) {
        rejected.push({ rowNo: ref, reason: 'no text on the page (scanned image or blank)', raw: null });
        continue;
      }
      try {
        rows.push(...parsePage(page.lines, ref));
      } catch (err) {
        if (!(err instanceof CellError)) throw err;
        rejected.push({ rowNo: ref, reason: err.message, raw: { firstLines: page.lines.slice(0, 6) } });
      }
    }
    return { rows, rejected };
  },
};

function parsePage(lines, ref) {
  const text = lines.join('\n');

  // Product Details rows carry SKU, qty and sub-order on one line.
  const skus = [];
  for (const line of lines) {
    const sub = line.match(SUB_ORDER);
    const found = findSkus(line);
    if (!sub || !found.length) continue;
    const sku = found[0];
    const between = line.slice(line.indexOf(sku) + sku.length, line.indexOf(sub[1])).trim().split(/\s+/);
    const qty = between.find((t) => /^\d{1,3}$/.test(t));
    if (!skus.some((s) => s.subOrder === sub[1])) skus.push({ sku, subOrder: sub[1], qty: qty ? Number(qty) : null });
  }

  // "Purchase Order No.  Invoice No.  Order Date  Invoice Date" with the values on the next line.
  let invoiceNo = null;
  let orderDate = null;
  let invoiceDate = null;
  // The values line starts with the purchase order number and carries two dates. It is
  // usually right under the headings, but a long "Place of Supply" can wrap in between.
  const head = lines.findIndex((l) => /invoice\s*no/i.test(l) && /order\s*date/i.test(l));
  const valuesLine = head === -1
    ? null
    : lines.slice(head + 1, head + 5).find((l) => /^\d{10,22}\s+\S+\s+\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/.test(l));
  if (valuesLine) {
    const vals = valuesLine.split(/\s+/);
    const dates = vals.filter((v) => /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(v));
    invoiceNo = vals[1];
    orderDate = dateFrom(dates[0] || '', /(.+)/);
    invoiceDate = dateFrom(dates[1] || dates[0] || '', /(.+)/);
  }
  // An invoice number has a digit in it — never a heading word like "Order".
  invoiceNo = invoiceNo || firstMatch(text, /Invoice\s*No\.?\s*:\s*([A-Za-z]*\d[A-Za-z0-9-]{3,})/i);
  orderDate = orderDate || dateFrom(text, /Order\s*Date\s*:?\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i);
  invoiceDate = invoiceDate || dateFrom(text, /Invoice\s*Date\s*:?\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i);

  const items = [];
  let grandTotal = null;
  let otherCharges = 0;
  const lastAmount = (line) => {
    const vals = [...line.matchAll(/(?:Rs\.?\s*|₹\s*)(-?[\d,]+\.\d{2})/g)];
    return vals.length ? paise(vals[vals.length - 1][1]) : null;
  };
  for (const line of lines) {
    if (/^\s*total\b/i.test(line)) {
      grandTotal = lastAmount(line) ?? grandTotal;
      continue;
    }
    // "Other Charges 630492 NA Rs.6.80 Rs.0 Rs.6.48 Rs.6.80" — logistics fee the buyer
    // paid. Part of the invoice total, not a product line; its qty is "NA".
    if (/^\s*other\s*charges\b/i.test(line)) {
      otherCharges += lastAmount(line) || 0;
      continue;
    }
    const it = itemFromLine(line);
    if (it && it.total !== 0) items.push(it);
  }

  const inv = { orderId: skus[0]?.subOrder, skus, items, grandTotal, shippingCharge: otherCharges };
  validateInvoice(inv, { orderIdRe: SUB_ORDER_ID });
  skus.forEach((s, i) => {
    if (s.qty != null && s.qty !== items[i].qty) {
      throw new CellError(`label says qty ${s.qty} for ${s.sku} but the invoice line says ${items[i].qty}`);
    }
  });

  const ship = shipTo(lines, /customer\s*address|ship\s*to|bill\s*to/i, /if\s*undelivered|return\s*to|sold\s*by|gstin/i);
  return skus.map((s, i) => {
    const parsed = parseSku(s.sku);
    const it = items[i];
    const key = orderItemKey('meesho', { subOrderNo: s.subOrder });
    return {
      rowNo: ref,
      entity: 'order',
      key,
      payload: {
        platform: 'meesho',
        order_item_key: key,
        order_id: s.subOrder.split('_')[0],
        // Sub-orders printed on one label travel in one packet.
        shipment_key: invoiceNo ? `inv:${invoiceNo}` : `page:${skus.map((x) => x.subOrder).join(',')}`,
        invoice_no: invoiceNo,
        invoice_date: invoiceDate,
        order_date: orderDate,
        sku: parsed.sku,
        code: parsed.code,
        qty: it.qty,
        gross_paise: it.gross,
        discount_paise: it.discount,
        taxable_paise: it.taxable,
        tax_paise: it.tax,
        total_paise: it.total,
        ship_state: ship.state,
        ship_pincode: ship.pincode,
        cancelled: 0,
      },
    };
  });
}
