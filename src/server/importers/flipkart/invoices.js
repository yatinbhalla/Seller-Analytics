import { CellError, paise } from '../../lib/parse.js';
import { parseSku } from '../../catalog/sku.js';
import { orderItemKey } from '../keys.js';
import { dateFrom, findSkus, firstMatch, itemFromLine, shipTo, validateInvoice } from '../invoiceText.js';

/**
 * Flipkart / Shopsy label + tax invoice PDF (Seller Hub → orders → print labels).
 *
 * One page per shipment: the shipping label (with SKU and qty) on top and the tax
 * invoice below. Checked against real labels on 2026-10-22: "SKU ID | Description QTY"
 * rows on the label, "Order Id: Invoice No:" headings with values on the next line,
 * item rows of Qty, Gross, Discount, Taxable, IGST, CESS, Total, a "Handling Fee" row,
 * and "TOTAL PRICE:". The ship-to state is an ISO code (IN-UP). A page that does not
 * read cleanly is quarantined with its reason — never guessed.
 */
const ORDER_ID = /^OD\d{12,22}$/;

export default {
  kind: 'flipkart.invoices',
  platform: 'flipkart',
  entity: 'order',
  label: 'Flipkart invoice PDF',
  accepts: 'pdf',
  detect({ pages }) {
    const text = pages.slice(0, 3).map((p) => p.lines.join('\n')).join('\n');
    if (!/tax\s*invoice/i.test(text)) return null;
    const hits = (/\bOD\d{12,22}\b/.test(text) ? 2 : 0) + (/flipkart|shopsy/i.test(text) ? 1 : 0);
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
  const orderId = firstMatch(text, /\b(OD\d{12,22})\b/);
  // The headings "Order Id: Invoice No: GSTIN:" sit on one line and their values on
  // the next, so the invoice number is the token right after the order ID there.
  const invoiceNo =
    firstMatch(text, /\bOD\d{12,22}\s+([A-Z0-9]{10,20})\b/) ||
    firstMatch(text, /Invoice\s*(?:No\.?|Number)\s*[:#]?\s*#?\s*(?!GSTIN)([A-Z0-9][A-Z0-9/-]{5,})/i);
  const orderDate = dateFrom(text, /Order\s*Date\s*:?\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i);
  const invoiceDate = dateFrom(text, /Invoice\s*Date\s*:?\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i);

  // SKUs in the order the label lists them, each with the qty printed after it.
  const skus = [];
  for (const line of lines) {
    for (const sku of findSkus(line)) {
      const after = line.slice(line.indexOf(sku) + sku.length).trim().split(/\s+/);
      const qty = [...after].reverse().find((t) => /^\d{1,3}$/.test(t));
      if (!skus.some((s) => s.sku === sku)) skus.push({ sku, qty: qty ? Number(qty) : null });
    }
  }

  const items = [];
  let shippingCharge = 0;
  for (const line of lines) {
    if (/^\s*(grand\s*)?total\b/i.test(line)) continue;
    const it = itemFromLine(line);
    if (!it) continue;
    if (/shipping|handling/i.test(it.label)) {
      shippingCharge += it.total;
      continue;
    }
    if (it.total === 0) continue;
    items.push(it);
  }
  const grandRaw = firstMatch(text, /(?:Grand\s*Total|TOTAL\s*PRICE)\s*:?\s*(?:₹|Rs\.?)?\s*(-?[\d,]+\.\d{2})/i);
  const grandTotal = grandRaw ? paise(grandRaw) : null;

  const inv = { orderId, skus, items, grandTotal, shippingCharge };
  validateInvoice(inv, { orderIdRe: ORDER_ID });
  skus.forEach((s, i) => {
    if (s.qty != null && s.qty !== items[i].qty) {
      throw new CellError(`label says qty ${s.qty} for ${s.sku} but the invoice line says ${items[i].qty}`);
    }
  });

  const platform = /shopsy/i.test(text) ? 'shopsy' : 'flipkart';
  const ship = shipTo(lines, /shipping(\s*\/\s*customer)?\s*address|ship\s*to|deliver\s*to/i, /sold\s*by|seller|billing\s*address|gstin/i);
  return skus.map((s, i) => {
    const parsed = parseSku(s.sku);
    const it = items[i];
    const key = orderItemKey('flipkart', { orderId, sku: parsed.sku });
    return {
      rowNo: ref,
      entity: 'order',
      key,
      payload: {
        platform,
        order_item_key: key,
        order_id: orderId,
        // One label, one packet: every line on this page shares the ₹7.
        shipment_key: invoiceNo || orderId,
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
