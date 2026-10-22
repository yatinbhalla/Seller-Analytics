import { excelImporter } from '../excelImporter.js';
import { findTable, mapRows, field, required, soft } from '../table.js';
import { date, id, int, paise, percent, text } from '../../lib/parse.js';
import { parseSku } from '../../catalog/sku.js';
import { orderItemKey } from '../keys.js';

/**
 * Meesho payment file (Supplier Panel → Payments → download), checked against a real
 * file on 2026-10-22.
 *
 * "Order Payments" sheet: a group-heading row, the header row, then a row of formula
 * letters ("A", "(B + C + G + …)") before the data. Two column names repeat — "Fixed
 * Fee (Incl. GST)" and the warehousing fee — and Meesho's own formula for Final
 * Settlement Amount uses the FIRST of each, which is what findTable picks.
 *
 *   Final = B + C + G + H + I + L + Q + R + S + T + U + V + W + Y + AA + AD + AF + AX
 *
 * Every one of those columns is read below, so the breakdown adds up to the payout
 * exactly; other_paise only catches a column Meesho adds later.
 *
 * Live Order Status is Delivered (sale), Return or RTO (txn_type return / rto; both
 * carry the sale and its reversal on one line), Cancelled, or blank — a later recovery (e.g. Affiliate Fee)
 * or claim against an order already paid.
 *
 * Ads Cost, Referral Payments and Compensation and Recovery are lines of their own,
 * not tied to an order.
 */
const spec = {
  required: ['subOrder', 'finalSettlement', 'paymentDate'],
  columns: {
    subOrder: ['Sub Order No', 'Sub Order Number', 'Suborder Number', 'Sub-order No'],
    orderDate: ['Order Date'],
    dispatchDate: ['Dispatch Date'],
    sku: ['Supplier SKU', 'SKU'],
    orderSource: ['Order source'],
    liveStatus: ['Live Order Status', 'Order Status'],
    gstPct: ['Product GST %'],
    listingPrice: ['Listing Price (Incl. taxes)'],
    qty: ['Quantity', 'Qty'],
    txnId: ['Transaction ID', 'UTR', 'UTR Number'],
    paymentDate: ['Payment Date'],
    finalSettlement: ['Final Settlement Amount'],
    priceType: ['Price Type'],
    totalSale: ['Total Sale Amount (Incl. Shipping & GST)', 'Total Sale Amount'],
    totalSaleReturn: ['Total Sale Return Amount (Incl. Shipping & GST)', 'Total Sale Return Amount'],
    fixedFee: ['Fixed Fee (Incl. GST)', 'Fixed Fee'],
    warehousingFee: ['Warehousing fee (inc Gst)', 'Warehousing fee'],
    returnPremium: ['Return premium (incl GST)', 'Return premium'],
    returnPremiumOfReturn: ['Return premium (incl GST) of Return', 'Return premium of Return'],
    commission: ['Meesho Commission (Incl. GST)', 'Meesho Commission'],
    goldFee: ['Meesho gold platform fee (Incl. GST)', 'Meesho gold platform fee'],
    mallFee: ['Meesho mall platform fee (Incl. GST)', 'Meesho mall platform fee'],
    returnShipping: ['Return Shipping Charge (Incl. GST)', 'Return Shipping Charge'],
    gstCompensation: ['GST Compensation (PRP Shipping)'],
    shipping: ['Shipping Charge (Incl. GST)', 'Shipping Charge'],
    netOtherSupport: ['Net Other Support Service Charges (Excl. GST)', 'Net Other Support Service Charges'],
    tcs: ['TCS'],
    tds: ['TDS'],
    compensation: ['Compensation'],
    claims: ['Claims'],
    recovery: ['Recovery'],
    compensationReason: ['Compensation Reason'],
    claimsReason: ['Claims Reason'],
    recoveryReason: ['Recovery Reason'],
  },
};

const m = (get, name) => field(name, paise, get(name)) ?? 0;

export default excelImporter({
  kind: 'meesho.payments',
  platform: 'meesho',
  entity: 'settlement',
  label: 'Meesho payment file',
  spec,
  row(get) {
    const subOrder = field('Sub Order No', id, get('subOrder'));
    // The formula-letter row under the header, and any blank spacer, carry no order.
    if (!subOrder) return null;
    const net = required('Final Settlement Amount', field('Final Settlement Amount', paise, get('finalSettlement')));
    const paymentDate = field('Payment Date', date, get('paymentDate'));
    const status = text(get('liveStatus')) || '';
    const parsed = parseSku(get('sku'));

    const sale = m(get, 'totalSale');
    const refund = m(get, 'totalSaleReturn');
    const commission = m(get, 'commission') + m(get, 'goldFee') + m(get, 'mallFee');
    const fixedFee = m(get, 'fixedFee') + m(get, 'warehousingFee');
    const shipping = m(get, 'shipping') + m(get, 'gstCompensation');
    const reverseShip = m(get, 'returnShipping') + m(get, 'returnPremium') + m(get, 'returnPremiumOfReturn');
    const tcs = m(get, 'tcs');
    const tds = m(get, 'tds');
    const taxWithheld = tcs + tds;
    const penalty = m(get, 'recovery') + m(get, 'netOtherSupport');
    const claim = m(get, 'compensation') + m(get, 'claims');
    const known = sale + refund + commission + fixedFee + shipping + reverseShip + taxWithheld + penalty + claim;

    const reason = [text(get('recoveryReason')), text(get('claimsReason')), text(get('compensationReason'))].filter(Boolean).join('; ') || null;
    let txnType;
    if (/rto/i.test(status)) txnType = 'rto';
    else if (/return/i.test(status)) txnType = 'return';
    else if (/deliver|shipped/i.test(status)) txnType = 'sale';
    else if (/cancel/i.test(status)) txnType = 'cancelled';
    else txnType = claim ? 'claim' : 'adjustment';

    const txnId = field('Transaction ID', id, get('txnId'));
    const itemKey = orderItemKey('meesho', { subOrderNo: subOrder });
    return {
      entity: 'settlement',
      // A recovery and a claim can land on the same order in the same payment, so
      // adjustment lines also key on their reason.
      key: `${itemKey}|${txnType}|${txnId || paymentDate || ''}${txnType === 'adjustment' || txnType === 'claim' ? `|${reason || ''}` : ''}`,
      payload: {
        platform: 'meesho',
        order_item_key: itemKey,
        order_id: subOrder.split('_')[0],
        sku: parsed?.sku ?? null,
        code: parsed?.code ?? null,
        txn_type: txnType,
        payment_date: paymentDate,
        settlement_ref: txnId,
        sale_paise: sale,
        refund_paise: refund,
        commission_paise: commission,
        fixed_fee_paise: fixedFee,
        shipping_paise: shipping,
        reverse_ship_paise: reverseShip,
        collection_paise: 0,
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
        gst_pct: soft(percent, get('gstPct')),
        invoice_no: null,
        invoice_date: null,
        breakdown_json: JSON.stringify({
          liveStatus: status || null,
          priceType: text(get('priceType')),
          adOrder: /ad order/i.test(text(get('orderSource')) || '') || undefined,
          listingPricePaise: soft(paise, get('listingPrice')),
          reason,
        }),
      },
    };
  },
  extraTables({ sheets }) {
    const out = { rows: [], rejected: [] };
    for (const t of [adsTable, referralTable, compensationTable]) {
      const res = t(sheets);
      out.rows.push(...res.rows);
      out.rejected.push(...res.rejected);
    }
    return out;
  },
});

/** A line that belongs to no order: ads, referral rewards, platform recovery. */
function nonOrderLine({ key, txnType, when, ref, amount, ads = false, note }) {
  return {
    entity: 'settlement',
    key,
    payload: {
      platform: 'meesho', order_item_key: null, order_id: null, sku: null, code: null,
      txn_type: txnType, payment_date: when, settlement_ref: ref || null,
      sale_paise: 0, refund_paise: 0, commission_paise: 0, fixed_fee_paise: 0, shipping_paise: 0,
      reverse_ship_paise: 0, collection_paise: 0, tax_withheld_paise: 0, tcs_paise: 0, tds_paise: 0, penalty_paise: 0, claim_paise: 0,
      ads_paise: ads ? amount : 0, other_paise: ads ? 0 : amount, net_paise: amount,
      order_date: null, dispatch_date: null, qty: null, gst_pct: null, invoice_no: null, invoice_date: null,
      breakdown_json: JSON.stringify(note || {}),
    },
  };
}

function sheetRows(sheets, spec, sheetName, fn) {
  const table = findTable(sheets, spec);
  if (!table || table.missing.length) return { rows: [], rejected: [] };
  const res = mapRows(table, fn);
  for (const r of [...res.rows, ...res.rejected]) r.rowNo = `${sheetName}!${r.rowNo}`;
  return res;
}

/** Ads Cost: one row per campaign per day of spend; several days are deducted on one date. */
function adsTable(sheets) {
  return sheetRows(
    sheets,
    {
      sheet: /ads/i,
      required: ['adsTotal', 'deductionDate'],
      columns: {
        duration: ['Deduction Duration'],
        deductionDate: ['Deduction Date'],
        campaignId: ['Campaign ID'],
        txnId: ['Transaction ID'],
        gst: ['GST'],
        adsTotal: ['Total Ads Cost', 'Total Ad Cost'],
      },
    },
    'Ads',
    (get) => {
      const total = field('Total Ads Cost', paise, get('adsTotal'));
      if (total == null || total === 0) return null;
      const when = field('Deduction Date', date, get('deductionDate'));
      const spentOn = field('Deduction Duration', date, get('duration'));
      const campaign = field('Campaign ID', id, get('campaignId')) || '';
      return nonOrderLine({
        key: `ads|${campaign}|${spentOn || ''}|${when}|${field('Transaction ID', id, get('txnId')) || ''}`,
        txnType: 'ads', when, ref: campaign, amount: -Math.abs(total), ads: true,
        note: { campaignId: campaign, spentOn, gstPaise: field('GST', paise, get('gst')) },
      });
    },
  );
}

function referralTable(sheets) {
  return sheetRows(
    sheets,
    {
      sheet: /referral/i,
      required: ['rewardId', 'amount'],
      columns: { rewardId: ['Reward Id'], paymentDate: ['Payment Date'], reason: ['Reason'], amount: ['Net Referral Amount'] },
    },
    'Referral',
    (get) => {
      const amount = field('Net Referral Amount', paise, get('amount'));
      if (amount == null) return null; // "No data is available for these dates."
      const ref = field('Reward Id', id, get('rewardId'));
      const when = field('Payment Date', date, get('paymentDate'));
      return nonOrderLine({ key: `referral|${ref}|${when}`, txnType: 'referral', when, ref, amount, note: { reason: text(get('reason')) } });
    },
  );
}

function compensationTable(sheets) {
  return sheetRows(
    sheets,
    {
      sheet: /compensation|recovery/i,
      required: ['amount', 'when'],
      columns: { when: ['Date'], program: ['Program Name'], reason: ['Reason'], amount: ['Amount (inc GST) INR', 'Amount'] },
    },
    'Compensation',
    (get) => {
      const amount = field('Amount', paise, get('amount'));
      if (amount == null) return null;
      const when = field('Date', date, get('when'));
      const program = text(get('program')) || '';
      const reason = text(get('reason')) || '';
      return nonOrderLine({ key: `platform|${when}|${program}|${reason}|${amount}`, txnType: 'platform_adjustment', when, ref: program, amount, note: { program, reason } });
    },
  );
}
