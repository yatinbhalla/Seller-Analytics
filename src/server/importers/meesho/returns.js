import { excelImporter } from '../excelImporter.js';
import { field, required, soft } from '../table.js';
import { date, id, int, text } from '../../lib/parse.js';
import { parseSku } from '../../catalog/sku.js';
import { orderItemKey } from '../keys.js';
import { conditionOf, lifecycle, returnType } from '../returnStatus.js';

/**
 * Meesho returns / RTO report (Supplier Panel → Returns → download). Reads both the
 * return-created download and the delivered/closed one; rows for the same sub-order
 * merge into one return.
 *
 * Checked against real files on 2026-10-22: both downloads start with five lines of
 * supplier details above the header row, which findTable skips. RTO rows say "NA" for
 * the reason. The return-created file has a Status (Picked Up, Returned = on its way
 * back); the delivered file has no Status but a Delivered Date, which closes the return.
 */
const spec = {
  required: ['subOrder', 'returnType'],
  columns: {
    subOrder: ['Suborder Number', 'Sub Order No', 'Sub Order Number', 'Suborder No'],
    orderNo: ['Order Number', 'Order No'],
    sku: ['SKU', 'Supplier SKU'],
    qty: ['Qty', 'Quantity'],
    returnType: ['Type of Return', 'Return Type'],
    subType: ['Sub Type', 'Return Sub Type'],
    reason: ['Return Reason', 'Reason'],
    detailedReason: ['Detailed Return Reason', 'Return Sub Reason'],
    createdDate: ['Return Created Date', 'Return Created On', 'Return Date', 'Return Initiated Date'],
    closedDate: ['Return Delivered Date', 'Delivered Date', 'Return Received Date', 'Received Date', 'Return Closed Date'],
    status: ['Status', 'Return Status'],
    condition: ['Return Condition', 'Product Condition', 'Quality Check Status'],
    awb: ['AWB Number', 'AWB No'],
    dispatchDate: ['Dispatch Date'],
    priceType: ['Return Price Type'],
  },
};

export default excelImporter({
  kind: 'meesho.returns',
  platform: 'meesho',
  entity: 'return',
  label: 'Meesho returns report',
  spec,
  row(get) {
    const subOrder = required('Suborder Number', field('Suborder Number', id, get('subOrder')));
    const parsed = parseSku(get('sku'));
    const rawStatus = text(get('status'));
    const closedDate = field('Return Delivered Date', date, get('closedDate'));
    const life = lifecycle(rawStatus, closedDate);
    const type = returnType(`${text(get('returnType')) || ''} ${text(get('subType')) || ''}`);
    const key = orderItemKey('meesho', { subOrderNo: subOrder });
    return {
      entity: 'return',
      key,
      payload: {
        platform: 'meesho',
        return_key: key,
        order_item_key: key,
        order_id: field('Order Number', id, get('orderNo')) || subOrder.split('_')[0],
        sku: parsed?.sku ?? null,
        code: parsed?.code ?? null,
        qty: field('Qty', int, get('qty')) || 1,
        return_type: type,
        reason: text(get('reason')),
        sub_reason: text(get('detailedReason')),
        // 'Wrong/Defective Return Price' marks returns charged at the lower defective-return price.
        comments: /defective/i.test(text(get('priceType')) || '') ? text(get('priceType')) : null,
        created_date: field('Return Created Date', date, get('createdDate')),
        closed_date: life.status === 'closed' ? closedDate : null,
        status: life.status,
        outcome: life.outcome,
        condition: conditionOf(text(get('condition'))),
        raw_status: rawStatus,
        dispatch_date: soft(date, get('dispatchDate')),
        price_paise: null,
        invoice_no: null,
        invoice_date: null,
        // On an RTO this is the label's AWB; a customer return gets a pickup number of its own.
        tracking_id: soft(id, get('awb')),
      },
    };
  },
});
