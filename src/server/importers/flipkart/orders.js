import { excelImporter } from '../excelImporter.js';
import { field, required, soft } from '../table.js';
import { date, id, int, text } from '../../lib/parse.js';
import { parseSku } from '../../catalog/sku.js';
import { orderItemKey } from '../keys.js';

/**
 * Flipkart orders report (Seller Hub → Reports → Request New Report → Fulfilment
 * Reports → Orders). Columns as in the download of 2026-10-23; that download had no
 * rows, so the status values are Flipkart's documented ones, not seen in a real file.
 *
 * The report carries no price. Its lines are stored with total 0 and source
 * 'order_report', and take their price from the payment file, else the list price
 * (lines.js). An invoice for the same order line always wins over it.
 *
 * Cancelled before dispatch → the line is cancelled. Cancelled after dispatch is a
 * courier return: the returns report has it with its Return ID, so the line stays.
 *
 * Flipkart writes some cells wrapped: the SKU as """SKU:WH_P/1""". An order holding
 * the same SKU twice has two order items; the app keys a Flipkart line by order ID +
 * SKU (as the invoice and payment files do), so the two become one line with both
 * quantities.
 */
const spec = {
  required: ['orderItemId', 'orderId', 'orderDate', 'status', 'sku'],
  columns: {
    orderItemId: ['order_item_id'],
    orderId: ['order_id'],
    orderDate: ['order_date'],
    status: ['order_item_status'],
    sku: ['sku'],
    qty: ['quantity'],
    cancelledOn: ['order_cancellation_date'],
    dispatchedOn: ['dispatched_date'],
  },
};

export default excelImporter({
  kind: 'flipkart.orders',
  platform: 'flipkart',
  entity: 'order',
  label: 'Flipkart orders report',
  spec,
  row(get) {
    const orderId = required('order_id', field('order_id', id, get('orderId')));
    const parsed = parseSku(required('sku', unwrap(text(get('sku')))));
    const key = orderItemKey('flipkart', { orderId, sku: parsed.sku });
    const status = required('order_item_status', text(get('status')));
    const dispatched = soft(date, get('dispatchedOn'));
    const cancelled = (/cancel/i.test(status) || soft(date, get('cancelledOn'))) && !dispatched;
    return {
      entity: 'order',
      key,
      payload: {
        platform: 'flipkart',
        source: 'order_report',
        order_item_key: key,
        order_id: orderId,
        shipment_key: orderId,
        invoice_no: null,
        invoice_date: null,
        order_date: required('order_date', field('order_date', date, get('orderDate'))),
        sku: parsed.sku,
        code: parsed.code,
        qty: field('quantity', int, get('qty')) || 1,
        total_paise: 0,
        cancelled: cancelled ? 1 : 0,
      },
    };
  },
  finish(rows) {
    // One line per order + SKU: live items' quantities add up; a line is cancelled
    // only when every item on it was.
    const byKey = new Map();
    const kept = rows.filter((r) => {
      const first = byKey.get(r.key);
      if (!first) {
        byKey.set(r.key, r);
        return true;
      }
      const [a, b] = [first.payload, r.payload];
      if (a.cancelled === b.cancelled) a.qty += b.qty;
      else if (a.cancelled) Object.assign(a, { qty: b.qty, cancelled: 0 });
      return false;
    });
    rows.splice(0, rows.length, ...kept);
  },
});

const unwrap = (v) => v && v.replace(/^"+|"+$/g, '').replace(/^SKU:/i, '').trim();
