import { excelImporter } from '../excelImporter.js';
import { field, required, soft } from '../table.js';
import { date, id, int, paise, text } from '../../lib/parse.js';
import { parseSku } from '../../catalog/sku.js';
import { orderItemKey } from '../keys.js';
import { conditionOf, humanReason, lifecycle, returnType } from '../returnStatus.js';

/**
 * Flipkart returns report (Seller Hub → Returns → download), for Flipkart and Shopsy,
 * checked against real files on 2026-10-22. The open-returns download and the
 * closed-returns download are the same report; rows for the same Return ID merge.
 *
 * "Completion Status" (Open / Closed) says whether the return is finished; "Return
 * Status" (start, in_transit, delivered, …) says how it ended. Reasons arrive as codes
 * (QUALITY_ISSUE / QUALITY_NOT_AS_EXPECTED) and are made readable.
 */
const spec = {
  required: ['orderId', 'sku', 'returnType'],
  columns: {
    orderId: ['Order ID', 'Order Id'],
    orderItemId: ['Order Item ID', 'Order Item Id'],
    returnId: ['Return ID', 'Return Id'],
    returnType: ['Return Type'],
    status: ['Return Status', 'Status'],
    completion: ['Completion Status'],
    reason: ['Return Reason', 'Reason'],
    subReason: ['Return Sub-reason', 'Return Sub Reason', 'Sub Reason'],
    comments: ['Comments', 'Customer Comments', 'Return Comments'],
    sku: ['SKU', 'Seller SKU', 'SKU ID'],
    qty: ['Quantity', 'Qty'],
    price: ['Total Price'],
    createdDate: ['Return Requested Date', 'Return Created Date', 'Return Approval Date', 'Return Date', 'Return Initiated Date'],
    closedDate: ['Completed Date', 'Return Completed Date', 'Return Delivered Date', 'Return Delivery Date', 'Return Received Date'],
    condition: ['Return Condition', 'Product Condition', 'QC Status', 'Quality Check'],
    shopsy: ['Shopsy Order', 'Is Shopsy Order', 'Sales Channel', 'Channel'],
    invoiceNo: ['Invoice Number'],
    invoiceDate: ['Invoice Date'],
    trackingId: ['Tracking ID'],
  },
};

export default excelImporter({
  kind: 'flipkart.returns',
  platform: 'flipkart',
  entity: 'return',
  label: 'Flipkart returns report',
  spec,
  row(get) {
    const orderId = required('Order ID', field('Order ID', id, get('orderId')));
    const parsed = parseSku(required('SKU', text(get('sku'))));
    const rawStatus = text(get('status'));
    const completion = text(get('completion'));
    const closedDate = field('Completed Date', date, get('closedDate'));
    let life = lifecycle(rawStatus, closedDate);
    if (/^closed$/i.test(completion || '') && life.status !== 'closed') life = { status: 'closed', outcome: 'received' };
    if (/^open$/i.test(completion || '') && life.status === 'closed' && !closedDate) life = { status: 'open', outcome: null };
    const type = returnType(text(get('returnType')));
    const itemKey = orderItemKey('flipkart', { orderId, sku: parsed.sku });
    const returnId = field('Return ID', id, get('returnId'));
    // Without a Return ID, one line can only be returned once per type — which is
    // also how Flipkart reports it.
    const key = returnId || `${itemKey}|${type}`;
    return {
      entity: 'return',
      key,
      payload: {
        platform: /yes|true|shopsy/i.test(text(get('shopsy')) || '') ? 'shopsy' : 'flipkart',
        return_key: key,
        order_item_key: itemKey,
        order_id: orderId,
        sku: parsed.sku,
        code: parsed.code,
        qty: field('Quantity', int, get('qty')) || 1,
        return_type: type,
        reason: humanReason(text(get('reason'))),
        sub_reason: humanReason(text(get('subReason'))),
        comments: text(get('comments')),
        created_date: field('Return Requested Date', date, get('createdDate')),
        closed_date: life.status === 'closed' ? closedDate : null,
        status: life.status,
        outcome: life.outcome,
        condition: conditionOf(text(get('condition'))),
        raw_status: [rawStatus, completion].filter(Boolean).join(' / ') || null,
        dispatch_date: null,
        price_paise: soft(paise, get('price')),
        invoice_no: soft(id, get('invoiceNo')),
        invoice_date: soft(date, get('invoiceDate')),
        // On an RTO this is the label's AWB; a customer return gets a pickup number of its own.
        tracking_id: soft(id, get('trackingId')),
      },
    };
  },
});
