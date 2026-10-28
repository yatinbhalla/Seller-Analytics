import { localToday } from '../lib/today.js';
import { economicsContext, loadLines } from './lines.js';

/**
 * Profit from the payments actually received, one payment at a time, on the day it
 * was paid — not from the orders sent, which can still be cancelled, returned or
 * come back as RTO.
 *
 * Each payment file settles an order once, by how it ended: a kept sale is money in;
 * a customer return is one line holding the sale, the refund and the return-shipping
 * charge; an RTO's sale and refund cancel out. Penalties, claims, ads and TCS/TDS
 * come as lines of their own. So every payment line is an event with its own profit:
 *
 *   profit = money received + TCS/TDS held back (claimed back, not a cost)
 *            − change in cost of goods − ₹7 packet − change in GST (if switched on)
 *
 * - Cost of goods is charged while the goods are gone: on a sale, and on a return or
 *   RTO that did not come back in good condition (damaged, lost or still on its way).
 *   A return of a sale paid earlier gives the cost back once the item is restocked.
 * - The ₹7 packet is charged once per packet, on that order's first sale, return or
 *   RTO payment: it is spent whether the parcel was kept or came back.
 * - An order not paid yet carries no profit; it is money to come (paymentsDue).
 * - A payment whose cost of goods is needed but not known gets profit = null, never a
 *   cost of zero.
 */
const FAM = (t) => `CASE WHEN ${t}.platform = 'meesho' THEN 'meesho' ELSE 'flipkart' END`;

const PAYMENTS_SQL = `
SELECT s.*, ${FAM('s')} AS fam, COALESCE(lk.to_key, s.order_item_key) AS link_key
  FROM settlement_lines s
  LEFT JOIN v_order_links lk ON lk.fam = ${FAM('s')} AND lk.from_key = s.order_item_key
 ORDER BY s.payment_date, s.id`;

/** What each payment line is, for display and for the profit rules. */
export const KINDS = {
  sale: 'Sale',
  return: 'Return',
  rto: 'RTO',
  cancelled: 'Cancelled order',
  penalty: 'Penalty or recovery',
  claim: 'Claim or compensation',
  ads: 'Ads',
  tax: 'TCS / TDS',
  other: 'Other',
};

export function kindOf(txnType) {
  if (txnType === 'sale' || txnType === 'return' || txnType === 'rto' || txnType === 'cancelled' || txnType === 'ads') return txnType;
  if (txnType === 'adjustment' || txnType === 'fines') return 'penalty';
  if (txnType === 'claim' || txnType === 'rebate' || txnType === 'referral') return 'claim';
  if (txnType === 'tcs' || txnType === 'tds') return 'tax';
  return 'other';
}

/** The parts every payment line is made of; they always add up to what was paid. */
export const PARTS = {
  price: 'Price the buyer paid',
  refund: 'Refund',
  shipping: 'Shipping',
  commission: 'Commission',
  fees: 'Fixed and collection fees',
  tax: 'TCS / TDS',
  deductions: 'Penalties, claims and ads',
  other: 'Other',
};

function partsOf(s) {
  return {
    price: s.sale_paise,
    refund: s.refund_paise,
    shipping: s.shipping_paise + s.reverse_ship_paise,
    commission: s.commission_paise,
    fees: s.fixed_fee_paise + s.collection_paise,
    tax: s.tax_withheld_paise,
    deductions: s.penalty_paise + s.claim_paise + s.ads_paise,
    // Whatever the named columns do not cover, so the parts always add up to the net.
    other: s.net_paise - (s.sale_paise + s.refund_paise + s.shipping_paise + s.reverse_ship_paise + s.commission_paise
      + s.fixed_fee_paise + s.collection_paise + s.tax_withheld_paise + s.penalty_paise + s.claim_paise + s.ads_paise),
  };
}

/**
 * The same parts as the seller prices on each platform, for explaining payouts.
 *
 * Meesho: the seller sets the price to be settled on and Meesho adds its shipping on
 * top for the buyer, so the buyer's price minus that shipping is the seller's own
 * price, and the forward shipping never moves the payout (checked on the real files:
 * that price holds steady per code while the buyer's price swings with distance).
 * Return shipping is still charged to the seller.
 *
 * Flipkart: the seller sets the price the buyer sees and Flipkart takes its fees and
 * shipping off it, so the parts stay as they are.
 */
function viewOf(platform, parts, s) {
  if (platform !== 'meesho') return parts;
  return { ...parts, price: s.sale_paise + s.shipping_paise, shipping: s.reverse_ship_paise };
}

/** What a part is called on a platform: "price" means a different thing on each. */
export function partLabel(platform, part) {
  if (part === 'price') return platform === 'meesho' ? 'Your price (buyer price less Meesho shipping)' : 'Price the buyer paid';
  if (part === 'shipping' && platform === 'meesho') return 'Return shipping';
  return PARTS[part];
}

const GOODS_EVENTS = new Set(['sale', 'return', 'rto']);

/**
 * Every payment line in the database with its profit, oldest first. Each order's
 * payments are worked through in date order, because a return's cost depends on
 * whether an earlier sale payment already charged it.
 */
export function loadPayments(db) {
  const ctx = economicsContext(db);
  const lines = new Map(loadLines(db, {}).map((l) => [l.natural_key, l]));
  const rows = db.prepare(PAYMENTS_SQL).all();
  const state = new Map();
  const out = [];
  for (const s of rows) {
    const kind = kindOf(s.txn_type);
    const line = s.link_key ? lines.get(`${s.fam}|main|${s.link_key}`) : null;
    const parts = partsOf(s);
    const taxBack = -s.tax_withheld_paise;
    let cost = 0;
    let packet = 0;
    let gst = 0;
    let costMissing = false;
    let restocked = false;

    if (GOODS_EVENTS.has(kind) && line) {
      const key = line.natural_key;
      let st = state.get(key);
      if (!st) state.set(key, (st = { charged: 0, gst: 0, packet: false }));
      restocked = kind !== 'sale' && isRestocked(line, ctx);
      const unitCost = line.unit_cost_paise == null ? null : line.unit_cost_paise * line.qty;
      const target = kind === 'sale' || !restocked ? unitCost : 0;
      // An unknown cost on either side leaves the change unknown, unless nothing moved.
      cost = target === st.charged ? 0 : target == null || st.charged == null ? null : target - st.charged;
      st.charged = target;
      costMissing = cost == null;
      if (!st.packet) {
        st.packet = true;
        packet = line.first_in_shipment ? ctx.packagingPaise : 0;
      }
      if (ctx.gstMode === 'deduct_output') {
        const owed = kind === 'sale' ? line.tax_paise || 0 : 0;
        gst = owed - st.gst;
        st.gst = owed;
      }
    }

    const profit = cost == null ? null : s.net_paise + taxBack - cost - packet - gst;
    out.push({
      id: s.id,
      date: s.payment_date,
      platform: line?.platform === 'shopsy' ? 'shopsy' : s.platform,
      kind,
      txnType: s.txn_type,
      ref: s.settlement_ref,
      orderKey: line ? line.natural_key : null,
      itemKey: s.link_key,
      orderId: s.order_id || line?.order_id || null,
      sku: s.sku || line?.sku || null,
      code: line?.code || line?.raw_code || s.code || null,
      rawCode: line?.raw_code || s.code || null,
      qty: line?.qty || s.qty || 1,
      productId: line?.product_id ?? null,
      productName: line?.product_name || null,
      variantId: line?.variant_id ?? null,
      categoryId: line?.category_id ?? null,
      saleDate: line?.sale_date || null,
      buyerState: line?.ship_state || null,
      shippingZone: s.shipping_zone || line?.shipping_zone || null,
      parts,
      view: viewOf(s.platform, parts, s),
      // Meesho's shipping, added on top of the seller's price and paid by the buyer.
      buyerShipping: s.platform === 'meesho' ? -s.shipping_paise : null,
      net: s.net_paise,
      taxBack,
      received: s.net_paise + taxBack,
      cost,
      packet,
      gst,
      restocked,
      costMissing,
      profit,
    });
  }
  return out;
}

function isRestocked(line, ctx) {
  return line.return_status === 'closed' && line.return_outcome === 'received'
    && (line.return_condition || ctx.defaultCondition) === 'good';
}

/** Payments inside the filters: the date range is the payment date. */
export function filterPayments(events, f = {}) {
  return events.filter(
    (e) =>
      (!f.from || (e.date && e.date >= f.from)) &&
      (!f.to || (e.date && e.date <= f.to)) &&
      (!f.platforms?.length || f.platforms.includes(e.platform)) &&
      (!f.categoryId || e.categoryId === Number(f.categoryId)) &&
      (!f.productId || e.productId === Number(f.productId)) &&
      (!f.code || e.code === f.code),
  );
}

export function emptyMoney() {
  const byKind = Object.fromEntries(Object.keys(KINDS).map((k) => [k, { n: 0, net: 0, profit: 0 }]));
  return {
    payments: 0, net: 0, taxBack: 0, received: 0, cost: 0, packets: 0, gst: 0,
    profit: 0, profitPayments: 0, costMissing: 0, costMissingNet: 0,
    parts: Object.fromEntries(Object.keys(PARTS).map((k) => [k, 0])),
    byKind,
  };
}

export function addPayment(t, e) {
  t.payments++;
  t.net += e.net;
  t.taxBack += e.taxBack;
  t.received += e.received;
  t.packets += e.packet;
  t.gst += e.gst;
  for (const k of Object.keys(PARTS)) t.parts[k] += e.parts[k];
  const k = t.byKind[e.kind];
  k.n++;
  k.net += e.net;
  if (e.profit == null) {
    t.costMissing++;
    t.costMissingNet += e.net;
  } else {
    t.cost += e.cost;
    t.profit += e.profit;
    t.profitPayments++;
    k.profit += e.profit;
  }
  return t;
}

/** Ratios once, at the end. Margin is profit over the money received. */
export function finishMoney(t) {
  return { ...t, margin: t.received > 0 ? t.profit / t.received : null };
}

export function moneyBy(events, keyFn) {
  const groups = new Map();
  for (const e of events) {
    for (const k of [].concat(keyFn(e))) {
      if (k == null) continue;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = emptyMoney()));
      addPayment(g, e);
    }
  }
  return new Map([...groups].map(([k, g]) => [k, finishMoney(g)]));
}

const median = (sorted) => sorted[Math.floor((sorted.length - 1) / 2)];
const at = (sorted, p) => sorted[Math.round((sorted.length - 1) * p)];

/** The key a payout is compared within: same platform, product code and pack size. */
export const skuKey = (e) => `${e.platform}|${e.code}|${e.qty}`;

/**
 * Why the same SKU is paid differently. For each SKU (platform, code, pack size) with
 * three or more kept-sale payments: the usual payout (the middle payment), the range,
 * and which parts of the payment move it. The usual payment is a real payment, so a
 * single payment's gap from it splits exactly into its parts (see explainPayment).
 */
export function skuPayouts(events) {
  const sales = new Map();
  for (const e of events) {
    if (e.kind !== 'sale' || !e.code) continue;
    const k = skuKey(e);
    if (!sales.has(k)) sales.set(k, []);
    sales.get(k).push(e);
  }
  const out = new Map();
  for (const [k, list] of sales) {
    if (list.length < 3) continue;
    const byNet = [...list].sort((a, b) => a.net - b.net || a.id - b.id);
    const usual = median(byNet);
    const platform = usual.platform;
    const drivers = [];
    for (const part of Object.keys(PARTS)) {
      const vals = list.map((e) => e.view[part]).sort((a, b) => a - b);
      const spread = at(vals, 0.9) - at(vals, 0.1);
      if (spread >= 500) drivers.push({ part, label: partLabel(platform, part), low: vals[0], high: vals[vals.length - 1], spread });
    }
    drivers.sort((a, b) => b.spread - a.spread);
    // One code is often listed several times (CODE/1, CODE/40365, …), each at its own
    // price — on the real Meesho files the main reason one code is paid differently.
    const copies = new Map();
    for (const e of list) {
      if (!copies.has(e.sku)) copies.set(e.sku, []);
      copies.get(e.sku).push(e);
    }
    const byListing = [...copies]
      .filter(([, v]) => v.length >= 2)
      .map(([sku, v]) => ({
        sku, n: v.length,
        price: median(v.map((e) => e.view.price).sort((a, b) => a - b)),
        payout: median(v.map((e) => e.net).sort((a, b) => a - b)),
      }))
      .sort((a, b) => b.n - a.n);
    out.set(k, {
      byListing,
      key: k,
      n: list.length,
      usualId: usual.id,
      usual: usual.net,
      usualParts: usual.view,
      // The price the payout starts from (on Meesho, the seller's own price) and what
      // the platform usually keeps of it: on Meesho only TCS/TDS, on Flipkart its fees.
      usualPrice: usual.view.price,
      usualKept: median(list.map((e) => e.view.price - e.net).sort((a, b) => a - b)),
      low: byNet[0].net,
      high: byNet[byNet.length - 1].net,
      p10: at(byNet.map((e) => e.net), 0.1),
      p90: at(byNet.map((e) => e.net), 0.9),
      drivers,
    });
  }
  return out;
}

/** A kept-sale payment against its SKU's usual one: the gap, split into parts that add up to it. */
export function explainPayment(e, usual) {
  if (!usual || e.kind !== 'sale') return null;
  const parts = Object.keys(PARTS)
    .map((part) => ({ part, label: partLabel(e.platform, part), diff: e.view[part] - usual.usualParts[part] }))
    .filter((p) => p.diff !== 0)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return { usual: usual.usual, gap: e.net - usual.usual, parts };
}

/**
 * The Payments page and the money on Home: totals, by day, by platform, by SKU, and
 * month by month, all by payment date.
 */
export function paymentReport(db, f = {}, today = localToday()) {
  const events = filterPayments(loadPayments(db), f);
  const total = finishMoney(events.reduce(addPayment, emptyMoney()));
  const byDay = moneyBy(events, (e) => [e.date, `${e.date}|${e.platform}`]);
  const days = [...new Set(events.map((e) => e.date).filter(Boolean))].sort().map((day) => {
    const d = { day, received: byDay.get(day).net, profit: byDay.get(day).profit };
    for (const [k, g] of byDay) {
      const [kd, platform] = k.split('|');
      if (kd === day && platform) {
        d[`${platform}_received`] = g.net;
        d[`${platform}_profit`] = g.profit;
      }
    }
    return d;
  });
  const byPlatform = moneyBy(events, (e) => e.platform);
  const payouts = skuPayouts(events);
  const bySkuMoney = moneyBy(events, (e) => (e.code ? skuKey(e) : null));
  const skus = [...bySkuMoney].map(([key, m]) => {
    const [platform, code, qty] = key.split('|');
    const sample = events.find((e) => e.code && skuKey(e) === key);
    const sales = m.byKind.sale;
    return {
      key, platform, code, qty: Number(qty), product: sample?.productName || null, productId: sample?.productId ?? null,
      payments: m.payments, sales: sales.n, returns: m.byKind.return.n, rto: m.byKind.rto.n,
      received: m.net, profit: m.profit, costMissing: m.costMissing,
      profitPerSale: sales.n ? Math.round(sales.profit / sales.n) : null,
      payout: payouts.get(key) || null,
    };
  }).sort((a, b) => b.received - a.received);

  const products = [...moneyBy(events, (e) => e.productId ?? (e.rawCode ? `code:${e.rawCode}` : null))]
    .map(([key, m]) => {
      const sample = events.find((e) => (e.productId ?? `code:${e.rawCode}`) === key);
      return {
        key, name: sample?.productName || `Unknown code ${sample?.rawCode}`, profit: m.profit, margin: m.margin,
        received: m.net, sales: m.byKind.sale.n, returns: m.byKind.return.n + m.byKind.rto.n,
      };
    })
    .sort((a, b) => b.profit - a.profit);

  return {
    today,
    total,
    days,
    platforms: [...byPlatform].map(([platform, m]) => ({ platform, ...m })),
    products,
    skus,
    breakdown: breakdown(total),
    months: [...moneyBy(events, (e) => [(e.date || '').slice(0, 7)])]
      .map(([month, m]) => ({ month, ...breakdown(m) }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  };
}

/**
 * From what buyers paid down to profit, for a set of payments. Every step is a real
 * sum of payment parts, so the bars always add up to the profit. TCS and TDS are held
 * back from the bank amount but claimed back, so the steps run before them.
 */
export function breakdown(t) {
  const steps = [
    { label: 'Price buyers paid', value: t.parts.price },
    { label: 'Refunds on returns and RTO', value: t.parts.refund },
    { label: 'Commission', value: t.parts.commission },
    { label: 'Fixed and collection fees', value: t.parts.fees },
    { label: 'Shipping and return shipping', value: t.parts.shipping },
    { label: 'Penalties, claims and ads', value: t.parts.deductions },
    { label: 'Other', value: t.parts.other },
  ];
  steps.push({ label: '= Received (before TCS/TDS)', value: t.received, subtotal: true });
  if (t.gst) steps.push({ label: 'GST on kept sales', value: -t.gst });
  steps.push({ label: 'Cost of goods', value: -t.cost });
  steps.push({ label: 'Packets (₹7 each)', value: -t.packets });
  const before = steps.filter((s) => !s.subtotal).reduce((a, s) => a + s.value, 0);
  // Payments whose cost of goods is unknown are left out of profit, not counted at
  // zero cost; their own bar keeps the steps adding up and shows the gap.
  if (before !== t.profit) steps.push({ label: 'Left out: payments without a cost price', value: t.profit - before, payments: t.costMissing });
  steps.push({ label: '= Profit', value: t.profit, subtotal: true });
  return {
    steps,
    profit: t.profit,
    received: t.received,
    bankPaise: t.net,
    taxHeldPaise: t.taxBack,
    payments: t.payments,
    costMissing: t.costMissing,
    margin: t.received > 0 ? t.profit / t.received : null,
  };
}

/**
 * Payment lines for the Payments page, newest first, each kept sale with its gap from
 * its SKU's usual payment.
 */
export function paymentList(db, f = {}, { kind = '', code = '', q = '', limit = 200, offset = 0 } = {}) {
  const events = filterPayments(loadPayments(db), f);
  const payouts = skuPayouts(events);
  const needle = q.trim().toLowerCase();
  const rows = events
    .filter((e) => (!kind || e.kind === kind) && (!code || e.code === code)
      && (!needle || `${e.orderId || ''} ${e.itemKey || ''} ${e.sku || ''} ${e.productName || ''}`.toLowerCase().includes(needle)))
    .reverse();
  return {
    count: rows.length,
    rows: rows.slice(offset, offset + limit).map((e) => ({
      ...e,
      kindLabel: KINDS[e.kind],
      vsUsual: explainPayment(e, payouts.get(skuKey(e))),
    })),
  };
}

/** Money from payments per order (all time), for the Orders and Customers pages. */
export function moneyByOrder(db) {
  return moneyBy(loadPayments(db), (e) => e.orderKey);
}
