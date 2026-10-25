import { localToday } from '../lib/today.js';
import { analyse, reasonLabel } from './aggregate.js';
import { economicsContext, filterLines, loadLines, loadUnlinkedCosts } from './lines.js';
import { getSetting } from '../db/db.js';
import { buyerSummaries } from './customers.js';

export const PLATFORMS = ['flipkart', 'shopsy', 'meesho'];

/**
 * The dashboard's reports. Each takes the same filters:
 *   { from, to, platforms: ['meesho', …], categoryId, productId }
 * and is computed fresh from the database — there is no cache to go stale after an
 * import or an undo.
 */
function base(db, f) {
  const all = loadLines(db, { from: f.from, to: f.to });
  return { all, lines: filterLines(all, f), ctx: economicsContext(db) };
}

const strip = ({ reasons, ...rest }) => rest;

export function overview(db, f) {
  const { all, lines, ctx } = base(db, f);
  const byPlatform = analyse(all, lines, ctx, (l) => l.platform);
  const byDay = analyse(all, lines, ctx, (l) => `${l.sale_date}|${l.platform}`);
  const byProduct = analyse(all, lines, ctx, (l) => l.product_id ?? `code:${l.raw_code}`);
  const names = productNames(lines);

  const unlinked = loadUnlinkedCosts(db, f).filter((u) => !f.platforms?.length || f.platforms.includes(u.platform));
  const ads = unlinked.reduce((a, u) => a + (u.ads || 0), 0);
  const otherUnlinked = unlinked.reduce((a, u) => a + (u.net || 0) - (u.ads || 0), 0);

  const products = byProduct.groups
    .filter((g) => g.profitLines > 0)
    .map((g) => ({ key: g.key, name: names.get(g.key) || String(g.key), profit: g.profit, margin: g.margin, lines: g.lines, returnRate: g.returnRate }));
  products.sort((a, b) => b.profit - a.profit);

  return {
    total: strip(byPlatform.total),
    ads,
    otherUnlinked,
    profitAfterAds: byPlatform.total.profit + ads + otherUnlinked,
    platforms: PLATFORMS.map((p) => byPlatform.groups.find((g) => g.key === p)).filter(Boolean).map(strip),
    trend: trendRows(byDay.groups),
    best: products.slice(0, 5),
    worst: products.slice(-5).reverse().filter((p) => !products.slice(0, 5).includes(p)),
    topReasons: topReasons(byPlatform.total.reasons, 8),
  };
}

function trendRows(groups) {
  const days = new Map();
  for (const g of groups) {
    const [day, platform] = g.key.split('|');
    const d = days.get(day) || { day };
    d[`${platform}_gmv`] = g.gmv;
    d[`${platform}_profit`] = g.profit;
    d.gmv = (d.gmv || 0) + g.gmv;
    d.profit = (d.profit || 0) + g.profit;
    d.units = (d.units || 0) + g.units;
    d.returns = (d.returns || 0) + g.returns;
    days.set(day, d);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function productNames(lines) {
  const m = new Map();
  for (const l of lines) m.set(l.product_id ?? `code:${l.raw_code}`, l.product_name || `Unknown code ${l.raw_code}`);
  return m;
}

function topReasons(reasons, n) {
  return Object.entries(reasons || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([reason, count]) => ({ reason, count }));
}

/**
 * Products table: product → variant → code → listing SKU, each with totals overall
 * and per platform. Groups are keyed "level:id" so one pass fills every level.
 */
export function products(db, f) {
  const { all, lines, ctx } = base(db, f);
  const { groups, total } = analyse(all, lines, ctx, (l) => {
    const p = l.product_id ?? `code:${l.raw_code}`;
    const keys = [`p:${p}`, `p:${p}|${l.platform}`];
    if (l.variant_id) keys.push(`v:${l.variant_id}`, `v:${l.variant_id}|${l.platform}`);
    keys.push(`c:${l.raw_code}`, `c:${l.raw_code}|${l.platform}`, `s:${l.sku}`);
    return keys;
  });
  const by = new Map(groups.map((g) => [g.key, g]));
  const tree = new Map();
  for (const l of lines) {
    const pk = l.product_id ?? `code:${l.raw_code}`;
    let p = tree.get(pk);
    if (!p) {
      p = { id: l.product_id, key: pk, name: l.product_name || `Unknown code ${l.raw_code}`, category: l.category_name || 'Unmapped', variants: new Map() };
      tree.set(pk, p);
    }
    const vk = l.variant_id ?? `code:${l.raw_code}`;
    let v = p.variants.get(vk);
    if (!v) p.variants.set(vk, (v = { id: l.variant_id, label: l.variant_label || l.raw_code, packOf: l.pack_of, codes: new Map() }));
    let c = v.codes.get(l.raw_code);
    if (!c) v.codes.set(l.raw_code, (c = { code: l.raw_code, resolvedTo: l.code, skus: new Set() }));
    c.skus.add(l.sku);
  }
  const withPlatforms = (prefix) => {
    const out = { all: strip(by.get(prefix)) };
    for (const pl of PLATFORMS) if (by.has(`${prefix}|${pl}`)) out[pl] = strip(by.get(`${prefix}|${pl}`));
    return out;
  };
  const rows = [...tree.values()].map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    category: p.category,
    reasons: topReasons(by.get(`p:${p.key}`).reasons, 3),
    metrics: withPlatforms(`p:${p.key}`),
    variants: [...p.variants.values()].map((v) => ({
      id: v.id,
      label: v.label,
      packOf: v.packOf,
      metrics: v.id ? withPlatforms(`v:${v.id}`) : withPlatforms(`c:${[...v.codes.keys()][0]}`),
      codes: [...v.codes.values()].map((c) => ({
        code: c.code,
        resolvedTo: c.resolvedTo,
        metrics: withPlatforms(`c:${c.code}`),
        listings: [...c.skus].map((sku) => ({ sku, ...pickListing(by.get(`s:${sku}`)) })).sort((a, b) => b.lines - a.lines),
      })),
    })),
  }));
  rows.sort((a, b) => (b.metrics.all?.gmv || 0) - (a.metrics.all?.gmv || 0));
  return { total: strip(total), rows };
}

const pickListing = (g) => ({ lines: g.lines, units: g.units, gmv: g.gmv, returns: g.returns, profit: g.profit });

/** One product: variants × platforms, reasons per platform, price history, listing copies. */
export function productDetail(db, productId, f) {
  const { all, ctx } = base(db, f);
  const lines = filterLines(all, { ...f, productId });
  const res = analyse(all, lines, ctx, (l) => [
    `v:${l.variant_id}|${l.platform}`, `v:${l.variant_id}`, `pl:${l.platform}`,
    `wk:${weekOf(l.sale_date)}|${l.platform}`, `s:${l.sku}`,
  ]);
  const by = new Map(res.groups.map((g) => [g.key, g]));
  const product = db.prepare(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`).get(productId);
  const variants = db.prepare('SELECT * FROM variants WHERE product_id = ? ORDER BY pack_of, label').all(productId);

  const priceHistory = [];
  for (const g of res.groups) {
    if (!g.key.startsWith('wk:')) continue;
    const [wk, platform] = g.key.slice(3).split('|');
    priceHistory.push({ week: wk, platform, avgPricePaise: g.units ? Math.round(g.gmv / g.units) : null, avgDiscount: g.avgDiscount, units: g.units });
  }
  priceHistory.sort((a, b) => a.week.localeCompare(b.week));

  return {
    product,
    total: strip(res.total),
    reasons: topReasons(res.total.reasons, 10),
    platforms: PLATFORMS.filter((p) => by.has(`pl:${p}`)).map((p) => ({ platform: p, ...strip(by.get(`pl:${p}`)), reasons: topReasons(by.get(`pl:${p}`).reasons, 5) })),
    variants: variants.map((v) => ({
      ...v,
      all: by.has(`v:${v.id}`) ? strip(by.get(`v:${v.id}`)) : null,
      byPlatform: Object.fromEntries(PLATFORMS.filter((p) => by.has(`v:${v.id}|${p}`)).map((p) => [p, strip(by.get(`v:${v.id}|${p}`))])),
    })),
    priceHistory,
    listings: res.groups.filter((g) => g.key.startsWith('s:')).map((g) => ({ sku: g.key.slice(2), ...pickListing(g) })).sort((a, b) => b.lines - a.lines),
    codes: db.prepare(`SELECT cat.code, cat.display_code, cat.variant_label, cat.mrp_paise, cat.flipkart_price_paise, cat.meesho_price_paise,
                              (SELECT COUNT(*) FROM listings l WHERE l.code = cat.code) AS listing_copies
                         FROM v_catalog cat WHERE cat.product_id = ? ORDER BY cat.pack_of, cat.code`).all(productId),
    stock: db.prepare('SELECT * FROM v_stock_on_hand WHERE product_id = ?').all(productId),
  };
}

function weekOf(ymd) {
  if (!ymd) return 'unknown';
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Order lines with their money, newest first, for the Orders page. */
export function orderList(db, f, { q = '', status = '', limit = 200, offset = 0 } = {}) {
  const { all, lines, ctx } = base(db, f);
  const needle = q.trim().toLowerCase();
  const { perLine } = analyse(all, lines, ctx, null);
  const buyers = buyerSummaries(db, {});
  const rows = perLine
    .filter(({ line, e }) => {
      const text = `${line.order_id} ${line.order_item_key} ${line.sku} ${line.product_name || ''} ${line.buyer_name || ''} ${line.ship_city || ''} ${line.ship_pincode || ''}`;
      if (needle && !text.toLowerCase().includes(needle)) return false;
      if (status === 'returned' && !e.returned) return false;
      if (status === 'rto' && e.returnType !== 'rto') return false;
      if (status === 'unsettled' && e.settled) return false;
      if (status === 'cost_missing' && !e.costMissing) return false;
      if (status === 'repeat_buyer' && !buyers.get(line.buyer_key)?.flags.repeat) return false;
      if (status === 'frequent_returner' && !buyers.get(line.buyer_key)?.flags.frequentReturner) return false;
      return true;
    })
    .reverse();
  const buyerOf = (key) => {
    const b = key && buyers.get(key);
    return b ? { key, orders: b.orders, returned: b.returned, rto: b.rto, cancelled: b.cancelled, flags: b.flags } : null;
  };
  return {
    count: rows.length,
    rows: rows.slice(offset, offset + limit).map(({ line, e }) => ({
      key: line.natural_key, id: line.id, lineSource: line.line_source, priceEstimated: !!line.price_estimated, platform: line.platform, saleDate: line.sale_date, orderId: line.order_id, itemKey: line.order_item_key,
      sku: line.sku, code: line.code || line.raw_code, product: line.product_name, variant: line.variant_label, qty: line.qty,
      totalPaise: line.total_paise, payoutPaise: e.payout, estimated: e.estimated, profitPaise: e.profit, costMissing: e.costMissing,
      packagingPaise: e.packaging, returned: e.returned, returnType: e.returnType, returnStatus: line.return_status,
      returnReason: line.return_reason, restocked: e.restocked,
      buyerName: line.buyer_name, city: line.ship_city, state: line.ship_state, pincode: line.ship_pincode,
      paymentMode: line.payment_mode, linkedVia: line.linked_via, buyer: buyerOf(line.buyer_key),
      source: line.import_id ? `import #${line.import_id}, ${line.source_ref}` : `from the ${line.line_source} file — no invoice uploaded`,
    })),
  };
}

/** Returns page: every return with the order it reverses, and the breakdowns. */
export function returnsReport(db, f) {
  const { all, lines, ctx } = base(db, f);
  const res = analyse(all, lines.filter((l) => l.return_type), ctx, (l) => [
    `reason:${reasonLabel(l)}|${l.platform}`,
    `product:${l.product_id ?? l.raw_code}`,
  ]);
  const names = productNames(lines);
  const reasonGrid = {};
  for (const g of res.groups.filter((x) => x.key.startsWith('reason:'))) {
    const [reason, platform] = g.key.slice(7).split('|');
    reasonGrid[reason] = reasonGrid[reason] || { reason, total: 0 };
    reasonGrid[reason][platform] = g.returns;
    reasonGrid[reason].total += g.returns;
  }
  const perProduct = res.groups
    .filter((g) => g.key.startsWith('product:'))
    .map((g) => {
      const key = g.key.slice(8);
      const pid = Number(key);
      // Rate over sales the app has a record of; g.lines counts only their returns.
      const sold = lines.filter((l) => l.line_source !== 'return' && !l.adjustment_only && String(l.product_id ?? l.raw_code) === key).length;
      return { key, name: names.get(Number.isNaN(pid) ? `code:${key}` : pid) || key, returns: g.returns, sold, rate: sold ? g.lines / sold : null, returnCost: g.returnCost, topReason: g.topReason };
    })
    .sort((a, b) => b.returnCost - a.returnCost);

  const closed = res.perLine.filter(({ line }) => line.return_status === 'closed' && line.return_created && line.return_closed);
  const avgDaysToClose = closed.length
    ? Math.round(closed.reduce((a, { line }) => a + (Date.parse(line.return_closed) - Date.parse(line.return_created)) / 86400000, 0) / closed.length)
    : null;

  // Rates over every sale on record, not over the returned lines analysed here.
  const soldLines = lines.filter((l) => l.line_source !== 'return' && !l.adjustment_only).length;
  const total = strip(res.total);
  total.customerReturnRate = soldLines ? total.rateReturnsCustomer / soldLines : 0;
  total.rtoRate = soldLines ? total.rateReturnsRto / soldLines : 0;
  total.returnRate = total.customerReturnRate + total.rtoRate;
  return {
    total,
    soldLines,
    beforeHistory: res.total.returnsBeforeHistory,
    avgDaysToClose,
    reasons: Object.values(reasonGrid).sort((a, b) => b.total - a.total),
    perProduct,
    rows: res.perLine
      .map(({ line, e }) => ({
        platform: line.platform, returnKey: line.return_key, itemKey: line.order_item_key, sku: line.sku, product: line.product_name,
        type: line.return_type, reason: line.return_reason, subReason: line.return_sub_reason, comments: line.return_comments,
        created: line.return_created, closed: line.return_closed, status: line.return_status, outcome: line.return_outcome,
        condition: line.return_condition, restocked: e.restocked, returnCostPaise: e.outOfHistory ? null : e.returnCost, estimated: e.estimated,
        beforeHistory: !!e.outOfHistory,
      }))
      .sort((a, b) => String(b.created || '').localeCompare(String(a.created || ''))),
  };
}

/** Monthly P&L per platform, as a waterfall that always adds up. */
export function pnl(db, f) {
  const { all, lines, ctx } = base(db, f);
  const res = analyse(all, lines, ctx, (l) => [`${(l.sale_date || '').slice(0, 7)}|all`, `${(l.sale_date || '').slice(0, 7)}|${l.platform}`]);
  const unlinked = loadUnlinkedCosts(db, f).filter((u) => !f.platforms?.length || f.platforms.includes(u.platform));
  const ads = unlinked.reduce((a, u) => a + (u.ads || 0), 0);
  return {
    total: waterfall(res.total, ads),
    months: res.groups
      .map((g) => {
        const [month, platform] = g.key.split('|');
        return { month, platform, ...waterfall(g, 0) };
      })
      .sort((a, b) => a.month.localeCompare(b.month) || a.platform.localeCompare(b.platform)),
  };
}

/**
 * Sales down to profit. "Other / rounding" is whatever the named steps do not explain
 * (invoice vs settlement differences, offers, unsettled estimates), so the bars always
 * reconcile to the profit figure.
 */
function waterfall(t, ads) {
  const fees = Object.values(t.fees).reduce((a, b) => a + b, 0);
  const steps = [
    { label: 'Sales', value: t.gmv },
    { label: 'Returned sales', value: -t.returnedGmv },
    { label: 'Marketplace fees (settled)', value: fees - t.fees.claim - t.fees.taxWithheld },
    { label: 'Claims & compensation', value: t.fees.claim },
    { label: 'Estimated fees (not settled yet)', value: t.payoutEstimated + t.taxCreditEstimated - t.payoutEstimatedReturns - t.estimatedKeptGmv },
    { label: 'Estimated return charges (not settled yet)', value: t.payoutEstimatedReturns },
    { label: 'Refunds, recoveries & claims on earlier sales', value: t.adjustments },
  ];
  // TCS and TDS are not in the P&L at all: you claim them back, so the payout is shown
  // before them. What was held back is on the TCS & TDS page.
  const payoutBeforeTax = t.payout + t.taxCredit;
  const explained = steps.reduce((a, s) => a + s.value, 0);
  steps.push({ label: 'Other (GST on fees, offers, refunds not settled yet)', value: payoutBeforeTax - explained });
  steps.push({ label: '= Payout (before TCS/TDS)', value: payoutBeforeTax, subtotal: true });
  if (t.gst) steps.push({ label: 'GST on kept sales', value: -t.gst });
  steps.push({ label: 'Cost of goods', value: -t.cogs });
  steps.push({ label: 'Packaging (₹7 / packet)', value: -(t.packaging - t.packagingOnReturns) });
  steps.push({ label: 'Packaging lost on returns', value: -t.packagingOnReturns });
  if (ads) steps.push({ label: 'Ads', value: ads });

  // Lines with no cost price (or no payout estimate yet) are left out of profit
  // rather than counted at zero cost. Showing that as its own bar keeps the
  // waterfall adding up AND makes the gap visible.
  const profit = t.profit + ads;
  const beforeExclusion = steps.filter((s) => !s.subtotal).reduce((a, s) => a + s.value, 0);
  if (beforeExclusion !== profit) {
    steps.push({ label: 'Left out: lines without a cost or payout', value: profit - beforeExclusion, lines: t.costMissingLines + t.unsettledLines });
  }
  steps.push({ label: '= Profit', value: profit, subtotal: true });
  return {
    steps, profit, complete: t.costMissingLines === 0, costMissingLines: t.costMissingLines, estimatedLines: t.estimatedLines, lines: t.lines,
    taxHeldPaise: t.taxCredit, taxHeldEstimatedPaise: t.taxCreditEstimated, bankPayoutPaise: t.payout,
  };
}

/**
 * Money still to come, by where each unsettled order sits in the payment window.
 *
 * Marketplaces pay 7–15 days after dispatch (Settings → payment_days_min/max). An
 * unsettled, kept order is:
 *   - not due yet  — dispatched fewer than min days ago
 *   - due now      — inside the window; the payment can land any day
 *   - overdue      — past max days with nothing paid: worth a ticket
 * Amounts are the estimated payouts. Returned orders are left out — they bring a
 * deduction, not a payment. The date filter does not apply; this is about today.
 */
export function paymentsDue(db, f, today = localToday()) {
  const ctx = economicsContext(db);
  const min = Number(getSetting(db, 'payment_days_min'));
  const max = Number(getSetting(db, 'payment_days_max'));
  const all = loadLines(db, {});
  const lines = filterLines(all, { platforms: f.platforms, categoryId: f.categoryId });
  const { perLine } = analyse(all, lines, ctx, null);

  const bucket = () => ({ lines: 0, paise: 0, byPlatform: {} });
  const out = { min, max, today, notDue: bucket(), dueNow: bucket(), overdue: bucket(), beforePaymentFiles: bucket(), noEstimate: 0, byDay: {} };
  const dayMs = 86400000;
  // An order is overdue only if its payment was due once the imported payment files
  // had started: one due earlier was paid, or not, before the app's history.
  const firstPaid = firstPaymentDates(db);
  out.paymentFilesFrom = Object.fromEntries(firstPaid);
  for (const { line, e } of perLine) {
    if (e.settled || e.returned || e.outOfHistory || e.adjustmentOnly || !line.sale_date) continue;
    if (e.payout == null) {
      out.noEstimate++;
      continue;
    }
    const age = Math.round((Date.parse(today) - Date.parse(line.sale_date)) / dayMs);
    const dueBy = new Date(Date.parse(line.sale_date) + max * dayMs).toISOString().slice(0, 10);
    const first = firstPaid.get(line.platform === 'meesho' ? 'meesho' : 'flipkart');
    const b = age < min ? out.notDue : age <= max ? out.dueNow : !first || dueBy < first ? out.beforePaymentFiles : out.overdue;
    b.lines++;
    b.paise += e.payout;
    b.byPlatform[line.platform] = (b.byPlatform[line.platform] || 0) + e.payout;
    if (age <= max) {
      // Spread each order over its window so the calendar shows when money can land.
      const from = Math.max(0, min - age);
      const to = max - age;
      const share = e.payout / (to - from + 1);
      for (let d = from; d <= to; d++) {
        const day = new Date(Date.parse(today) + d * dayMs).toISOString().slice(0, 10);
        out.byDay[day] = (out.byDay[day] || 0) + share;
      }
    }
  }
  out.byDay = Object.entries(out.byDay)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, paise]) => ({ day, paise: Math.round(paise) }));
  const weekEnd = new Date(Date.parse(today) + 6 * dayMs).toISOString().slice(0, 10);
  out.next7Paise = out.byDay.filter((d) => d.day <= weekEnd).reduce((a, d) => a + d.paise, 0);
  return out;
}

/** Per platform family ('flipkart' covers Shopsy): the first payment date in the imported payment files. */
export function firstPaymentDates(db) {
  return new Map(
    db.prepare(`SELECT CASE WHEN platform = 'meesho' THEN 'meesho' ELSE 'flipkart' END AS fam, MIN(payment_date) AS d
                  FROM settlement_lines WHERE payment_date IS NOT NULL GROUP BY fam`)
      .all().map((r) => [r.fam, r.d]),
  );
}

/**
 * TCS and TDS held back from payouts — not costs, money to claim back:
 *   TCS (GST law, 0.5% of the taxable value) — credited on the GST portal; used to
 *     pay GST when filing.
 *   TDS (income tax, section 194-O, 0.1%) — shows in Form 26AS / AIS; claimed in the
 *     income tax return.
 *
 * Shown as positive "held back" amounts, by the month the payment was made, because
 * that is when the marketplace deposits it against your GSTIN / PAN. A TCS recovery
 * (Flipkart taking TCS back on an order returned later) shows as a negative amount.
 * The date range filters on payment date.
 */
export function taxCredits(db, f) {
  const rows = db
    .prepare(`SELECT substr(payment_date, 1, 7) AS month, platform,
                     -SUM(COALESCE(tcs_paise, 0)) AS tcs, -SUM(COALESCE(tds_paise, 0)) AS tds,
                     -SUM(CASE WHEN tcs_paise IS NULL AND tds_paise IS NULL THEN tax_withheld_paise ELSE 0 END) AS unsplit,
                     COUNT(DISTINCT settlement_ref) AS payments
                FROM settlement_lines
               WHERE tax_withheld_paise <> 0 AND payment_date IS NOT NULL
                 AND (@from IS NULL OR payment_date >= @from) AND (@to IS NULL OR payment_date <= @to)
               GROUP BY month, platform
               ORDER BY month DESC, platform`)
    .all({ from: f.from || null, to: f.to || null })
    .filter((r) => !f.platforms?.length || f.platforms.includes(r.platform));
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);

  // TCS/TDS still to come: held back from orders not settled yet (estimated).
  const all = loadLines(db, {});
  const { total } = analyse(all, filterLines(all, { platforms: f.platforms }), economicsContext(db), null);

  const payments = db
    .prepare(`SELECT payment_date, platform, settlement_ref,
                     -SUM(COALESCE(tcs_paise, 0)) AS tcs, -SUM(COALESCE(tds_paise, 0)) AS tds, COUNT(*) AS lines
                FROM settlement_lines
               WHERE tax_withheld_paise <> 0 AND payment_date IS NOT NULL
                 AND (@from IS NULL OR payment_date >= @from) AND (@to IS NULL OR payment_date <= @to)
               GROUP BY payment_date, platform, settlement_ref
               ORDER BY payment_date DESC LIMIT 200`)
    .all({ from: f.from || null, to: f.to || null })
    .filter((r) => !f.platforms?.length || f.platforms.includes(r.platform));

  return {
    tcs: sum('tcs'),
    tds: sum('tds'),
    unsplit: sum('unsplit'),
    pendingEstimate: total.taxCreditEstimated,
    months: rows,
    payments,
  };
}
