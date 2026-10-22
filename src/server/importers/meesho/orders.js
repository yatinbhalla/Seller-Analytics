import { excelImporter } from '../excelImporter.js';
import { field, required, soft } from '../table.js';
import { date, id, int, paise, text } from '../../lib/parse.js';
import { parseSku } from '../../catalog/sku.js';
import { orderItemKey } from '../keys.js';

/**
 * Meesho orders report (Supplier Panel → Orders → Download Orders Data → Select Date
 * Range), checked against a real 30-day download on 2026-10-23.
 *
 * One row per sub-order. The first column, oddly named "Reason for Credit Entry",
 * holds the order's status: DELIVERED, SHIPPED, READY_TO_SHIP, CANCELLED, RTO_*, LOST.
 * The price is the supplier's own price incl. GST — what the label's tax invoice
 * shows as the item total, not what the buyer paid with shipping.
 *
 * The report has no invoice number, GST split or buyer, so its lines are stored as
 * source 'order_report': an invoice for the same sub-order always wins over it, and
 * it only fills gaps in one already uploaded (see mergeOrder). RTOs stay order lines
 * here; the returns report and payment file say they came back.
 */
const spec = {
  required: ['subOrder', 'sku', 'orderDate', 'status', 'price'],
  columns: {
    status: ['Reason for Credit Entry', 'Order Status'],
    subOrder: ['Sub Order No'],
    orderDate: ['Order Date'],
    state: ['Customer State'],
    sku: ['SKU', 'Supplier SKU'],
    qty: ['Quantity'],
    price: ['Supplier Discounted Price (Incl GST and Commision)', 'Supplier Discounted Price (Incl GST and Commission)'],
    packetId: ['Packet Id'],
  },
};

export default excelImporter({
  kind: 'meesho.orders',
  platform: 'meesho',
  entity: 'order',
  label: 'Meesho orders report',
  spec,
  row(get) {
    const subOrder = required('Sub Order No', field('Sub Order No', id, get('subOrder')));
    const parsed = parseSku(required('SKU', text(get('sku'))));
    const qty = field('Quantity', int, get('qty')) || 1;
    const key = orderItemKey('meesho', { subOrderNo: subOrder });
    const packetId = soft(id, get('packetId'));
    return {
      entity: 'order',
      key,
      payload: {
        platform: 'meesho',
        source: 'order_report',
        order_item_key: key,
        order_id: subOrder.split('_')[0],
        // Sub-orders packed together share a packet, and so one ₹7.
        shipment_key: packetId ? `pkt:${packetId}` : `sub:${subOrder}`,
        invoice_no: null,
        invoice_date: null,
        order_date: required('Order Date', field('Order Date', date, get('orderDate'))),
        sku: parsed.sku,
        code: parsed.code,
        qty,
        total_paise: required('Supplier Discounted Price', field('Supplier Discounted Price', paise, get('price'))) * qty,
        ship_state: text(get('state')),
        cancelled: /^cancel/i.test(required('Status', text(get('status')))) ? 1 : 0,
      },
    };
  },
});
