import { localToday } from '../lib/today.js';
import { getSetting } from '../db/db.js';
import { overview, paymentsDue, pnl, productDetail, products, returnsReport, taxCredits } from '../metrics/reports.js';
import { stockReport } from '../inventory/ledger.js';
import { dataHealth } from '../metrics/health.js';
import { findAnomalies } from '../metrics/anomalies.js';
import { areaReport } from '../metrics/customers.js';

/**
 * The functions Gemini may call to answer "Ask your data".
 *
 * Every number in an answer comes from one of these — the same code the dashboard
 * uses. Results are trimmed to aggregates and product names: no order IDs, no
 * pincodes, no buyer data ever goes to the model. Money is converted to rupees so the
 * model does not have to.
 */
const filterParams = {
  from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive). Omit for all time.' },
  to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive). Omit for up to today.' },
  platforms: { type: 'array', items: { type: 'string', enum: ['flipkart', 'shopsy', 'meesho'] }, description: 'Limit to these platforms. Omit for all.' },
};

const rupees = (v) => (v == null ? null : Math.round(v) / 100);
const pct = (v) => (v == null ? null : Math.round(v * 1000) / 10);

function summary(t) {
  if (!t) return null;
  return {
    orderLines: t.lines, units: t.units, salesRs: rupees(t.gmv), netSalesRs: rupees(t.netSales),
    payoutRs: rupees(t.payout), estimatedPayoutLines: t.estimatedLines, profitRs: rupees(t.profit),
    marginPct: pct(t.margin), returnRatePct: pct(t.returnRate), customerReturnRatePct: pct(t.customerReturnRate),
    rtoRatePct: pct(t.rtoRate), returnCostRs: rupees(t.returnCost), avgDiscountPct: pct(t.avgDiscount),
    linesWithoutCost: t.costMissingLines, topReturnReason: t.topReason?.reason ?? null,
  };
}

// Buyer comments are free text; strip anything shaped like a phone number, pincode or email.
export const scrub = (s) => (s == null ? null : String(s).replace(/\S+@\S+/g, '[email]').replace(/\d[\d\s-]{5,}\d/g, '[number]'));

const f = (args) => ({ from: args.from || null, to: args.to || null, platforms: args.platforms || [] });

export function buildTools(db) {
  return {
    get_overview: {
      description: 'Business totals for a period: sales, payout, profit, margin, return rates, per platform, plus best and worst products.',
      parameters: { type: 'object', properties: filterParams },
      run: (a) => {
        const o = overview(db, f(a));
        return {
          total: summary(o.total), adsRs: rupees(o.ads), profitAfterAdsRs: rupees(o.profitAfterAds),
          platforms: o.platforms.map((p) => ({ platform: p.key, ...summary(p) })),
          bestProducts: o.best.map((p) => ({ name: p.name, profitRs: rupees(p.profit), marginPct: pct(p.margin) })),
          worstProducts: o.worst.map((p) => ({ name: p.name, profitRs: rupees(p.profit), marginPct: pct(p.margin) })),
          topReturnReasons: o.topReasons,
        };
      },
    },
    get_product_metrics: {
      description: 'Per-product metrics (all platforms and each platform), with variants (pack sizes). Use to compare products or find what to scale, fix or stop.',
      parameters: { type: 'object', properties: { ...filterParams, nameContains: { type: 'string', description: 'Only products whose name contains this text.' } } },
      run: (a) => {
        const r = products(db, f(a));
        const needle = (a.nameContains || '').toLowerCase();
        return r.rows
          .filter((p) => !needle || p.name.toLowerCase().includes(needle))
          .slice(0, 40)
          .map((p) => ({
            productId: p.id, name: p.name, category: p.category, all: summary(p.metrics.all),
            byPlatform: Object.fromEntries(Object.entries(p.metrics).filter(([k]) => k !== 'all').map(([k, v]) => [k, summary(v)])),
            variants: p.variants.map((v) => ({ label: v.label, all: summary(v.metrics.all) })),
            topReasons: p.reasons,
          }));
      },
    },
    get_product_detail: {
      description: 'One product in depth: per variant × platform, return reasons per platform, weekly average price and discount.',
      parameters: { type: 'object', properties: { ...filterParams, productId: { type: 'number' } }, required: ['productId'] },
      run: (a) => {
        const d = productDetail(db, Number(a.productId), f(a));
        return {
          name: d.product?.name, total: summary(d.total), reasons: d.reasons,
          platforms: d.platforms.map((p) => ({ platform: p.platform, ...summary(p), reasons: p.reasons })),
          variants: d.variants.map((v) => ({ label: v.label, all: summary(v.all) })),
          weeklyPrice: d.priceHistory.map((w) => ({ week: w.week, platform: w.platform, avgPriceRs: rupees(w.avgPricePaise), units: w.units })),
        };
      },
    },
    get_returns: {
      description: 'Returns analysis: reasons by platform, return rate and return cost per product, average days to close.',
      parameters: { type: 'object', properties: filterParams },
      run: (a) => {
        const r = returnsReport(db, f(a));
        return {
          total: summary(r.total), avgDaysToClose: r.avgDaysToClose, reasons: r.reasons.slice(0, 15),
          perProduct: r.perProduct.slice(0, 25).map((p) => ({ name: p.name, returns: p.returns, sold: p.sold, ratePct: pct(p.rate), returnCostRs: rupees(p.returnCost), topReason: p.topReason?.reason })),
          sampleComments: r.rows.filter((x) => x.comments || x.subReason).slice(0, 40).map((x) => ({ product: x.product, reason: x.reason, detail: scrub(x.subReason), comment: scrub(x.comments) })),
        };
      },
    },
    get_pnl: {
      description: 'Profit and loss waterfall in total and per month per platform.',
      parameters: { type: 'object', properties: filterParams },
      run: (a) => {
        const p = pnl(db, f(a));
        const conv = (w) => ({ profitRs: rupees(w.profit), steps: w.steps.map((s) => ({ label: s.label, rs: rupees(s.value) })) });
        return { total: conv(p.total), months: p.months.map((m) => ({ month: m.month, platform: m.platform, ...conv(m) })) };
      },
    },
    get_payments_due: {
      description: 'Money still to come: unsettled orders split into not due yet, due now (inside the 7–15 day payment window) and overdue, with expected amounts.',
      parameters: { type: 'object', properties: { platforms: filterParams.platforms } },
      run: (a) => {
        const p = paymentsDue(db, f(a));
        const b = (x) => ({ orders: x.lines, rs: rupees(x.paise), byPlatformRs: Object.fromEntries(Object.entries(x.byPlatform).map(([k, v]) => [k, rupees(v)])) });
        return { windowDays: [p.min, p.max], notDue: b(p.notDue), dueNow: b(p.dueNow), overdue: b(p.overdue), next7DaysRs: rupees(p.next7Paise) };
      },
    },
    get_tax_credits: {
      description: 'TCS (GST) and TDS (income tax) held back from payouts, by month and platform — claimable, not a cost.',
      parameters: { type: 'object', properties: filterParams },
      run: (a) => {
        const t = taxCredits(db, f(a));
        return { tcsRs: rupees(t.tcs), tdsRs: rupees(t.tds), stillToComeRs: rupees(t.pendingEstimate), months: t.months.map((m) => ({ month: m.month, platform: m.platform, tcsRs: rupees(m.tcs), tdsRs: rupees(m.tds) })) };
      },
    },
    get_stock: {
      description: 'Stock on hand per stock item (pieces), daily use, days of cover, low stock, reorder suggestion.',
      parameters: { type: 'object', properties: {} },
      run: () =>
        stockReport(db).map((s) => ({
          item: s.name, onHand: s.on_hand, dailyUse: s.dailyUse, daysCover: s.daysCover, low: s.low,
          suggestedReorder: s.suggestedReorder, inTransitReturns: s.inTransit, packsPossible: s.packs,
        })),
    },
    get_alerts: {
      description: 'Odd figures found in the marketplace files: counts and money per alert type (low payouts, penalties and recoveries, unrecorded returns, files that disagree, unusual fees, loss-making sales, …), plus overdue payments and stale returns.',
      parameters: { type: 'object', properties: filterParams },
      run: (a) => {
        const r = findAnomalies(db, f(a));
        return {
          counts: r.counts, markedOk: r.reviewedOk,
          byType: r.byType.map((t) => ({ alert: t.label, severity: t.severity, count: t.count, amountRs: rupees(t.amountPaise) })),
          overduePayments: { orders: r.gaps.overduePayments.lines, rs: rupees(r.gaps.overduePayments.paise) },
          returnsOpenTooLong: r.gaps.staleReturns.count,
        };
      },
    },
    get_areas: {
      description: 'Returns by area: orders, return and RTO rates and return cost per state, per city ("City, State"), or per Flipkart shipping zone, flagging areas above the average; plus COD vs prepaid. Totals only — no buyers.',
      parameters: {
        type: 'object',
        properties: {
          ...filterParams,
          level: { type: 'string', enum: ['state', 'city', 'zone'], description: 'Group by state (default), city or Flipkart shipping zone.' },
          state: { type: 'string', description: 'Only this state (e.g. to list its cities).' },
        },
      },
      run: (a) => {
        // Never PIN codes: with a name-free area this small, a buyer could be singled out.
        const level = ['state', 'city', 'zone'].includes(a.level) ? a.level : 'state';
        const r = areaReport(db, f(a), { level, state: a.state || '' });
        const row = (x) => ({
          orders: x.orders, customerReturns: x.returnsCustomer, rtos: x.returnsRto, returnRatePct: pct(x.returnRate),
          rtoRatePct: pct(x.rtoRate), returnCostRs: rupees(x.returnCost), topReason: x.topReason?.reason ?? null,
        });
        return {
          total: row(r.total), minOrdersForAboveAverage: r.minOrders, ordersWithoutArea: r.unknownLines,
          areas: r.rows.slice(0, 30).map((x) => ({ area: x.key, aboveAverage: x.aboveAverage, ...row(x) })),
          byPaymentMode: r.byPaymentMode.map((m) => ({ mode: m.key, ...row(m) })),
        };
      },
    },
    get_data_health: {
      description: 'Data problems that make numbers incomplete: missing upload days, unpaid orders, stale returns, codes without cost.',
      parameters: { type: 'object', properties: {} },
      run: () => {
        const h = dataHealth(db);
        return {
          missingInvoiceDays: h.missingInvoiceDays, unpaidOrders: h.unpaid.count, staleReturns: h.staleReturns.count,
          paymentsWithoutInvoice: h.paymentsWithoutInvoice.count, codesWithoutCost: h.codesWithoutCost.map((c) => c.code),
          unknownCodes: h.unknownCodes.map((c) => c.code), negativeStock: h.negativeStock.map((s) => s.name),
        };
      },
    },
  };
}

export const systemPrompt = (db) => `You are the analytics assistant inside a seller's dashboard. The seller sells home and baby
textiles on Flipkart, Shopsy and Meesho in India. Products have pack variants (1/2/4-pack) and
several listing copies per SKU code.

Rules:
- Every number you state must come from a tool result in this conversation. Never estimate,
  extrapolate or invent figures. If the tools cannot answer, say what data is missing.
- Money is in Indian rupees (₹). Profit already accounts for marketplace fees, cost price, and
  ₹7 packaging per packet (charged even on returns). ${
    getSetting(db, 'gst_mode') === 'deduct_output'
      ? 'The GST in each kept sale is taken off profit.'
      : 'Profit is before GST: the seller offsets GST on sales with input credit on purchases.'
  } TCS and TDS are claimed back, so they are not costs and are not in profit.
- "estimated" payouts are for orders not settled yet; say so when it matters.
- Be concrete and brief: lead with the answer, then 2–4 bullet points of evidence, then a
  suggested action (scale / fix / stop / restock / reprice) where it fits.
- Compare platforms when it helps: a product can win on Meesho and lose on Flipkart.
- You never see buyers. Area tools give state, city and zone totals only; never ask for names.
- Today's date is ${localToday()}.`;
