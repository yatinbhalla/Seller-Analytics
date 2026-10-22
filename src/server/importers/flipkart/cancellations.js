import { excelImporter } from '../excelImporter.js';
import { field, required, soft } from '../table.js';
import { date, id, int, paise, text } from '../../lib/parse.js';
import { parseSku } from '../../catalog/sku.js';
import { orderItemKey } from '../keys.js';

/**
 * Flipkart cancelled orders (Seller Hub → Orders → Cancellations → Download Order
 * List), checked against a real download on 2026-10-22.
 *
 * Two kinds of line come in this list:
 *   - Logistics Return = Yes: shipped, then sent back by the courier (RTO). The
 *     returns report has the same line with its Return ID and reason, so it is
 *     skipped here; importing it again would count that return twice.
 *   - Logistics Return = No: cancelled before it left. It marks the order line
 *     cancelled, which takes it out of sales, stock and packaging. If its invoice
 *     was already uploaded, what the invoice said is kept (see mergeOrder).
 *
 * The file carries the buyer's name and address; only state and PIN code are read.
 */
const spec = {
  required: ['orderId', 'sku', 'cancelledOn', 'cancelType'],
  columns: {
    cancelledOn: ['Order Cancellation Date'],
    orderDate: ['Order Approval Date'],
    orderId: ['Order ID', 'Order Id'],
    logisticsReturn: ['Logistics Return'],
    cancelType: ['Cancellation Type'],
    sku: ['SKU', 'Seller SKU'],
    qty: ['Quantity', 'Qty'],
    total: ['Total'],
    state: ['State'],
    pincode: ['PIN Code', 'Pincode'],
    invoiceNo: ['Invoice Number'],
  },
};

export default excelImporter({
  kind: 'flipkart.cancellations',
  platform: 'flipkart',
  entity: 'order',
  label: 'Flipkart cancelled orders',
  skipLabel: 'courier returns (already in the returns report)',
  spec,
  row(get) {
    const orderId = required('Order ID', field('Order ID', id, get('orderId')));
    const parsed = parseSku(required('SKU', text(get('sku'))));
    if (/^y/i.test(text(get('logisticsReturn')) || '')) return null;
    const key = orderItemKey('flipkart', { orderId, sku: parsed.sku });
    const invoiceNo = soft(id, get('invoiceNo'));
    return {
      entity: 'order',
      key,
      payload: {
        platform: 'flipkart',
        order_item_key: key,
        order_id: orderId,
        shipment_key: invoiceNo || orderId,
        invoice_no: invoiceNo,
        invoice_date: null,
        order_date: field('Order Approval Date', date, get('orderDate')),
        sku: parsed.sku,
        code: parsed.code,
        qty: field('Quantity', int, get('qty')) || 1,
        gross_paise: null,
        discount_paise: null,
        taxable_paise: null,
        tax_paise: null,
        total_paise: required('Total', field('Total', paise, get('total'))),
        ship_state: text(get('state')),
        ship_pincode: text(get('pincode')),
        cancelled: 1,
      },
    };
  },
});
