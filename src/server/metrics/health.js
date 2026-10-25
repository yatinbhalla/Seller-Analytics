import { localToday } from '../lib/today.js';
import { getSetting, integrityCheck } from '../db/db.js';
import { unknownCodes } from '../catalog/manage.js';

const FAM = (t) => `CASE WHEN ${t}.platform = 'meesho' THEN 'meesho' ELSE 'flipkart' END`;

/**
 * Data Health: everything that would make a dashboard number wrong or incomplete,
 * in one place, so it is fixed before it is believed.
 */
export function dataHealth(db, today = localToday()) {
  const staleDays = Number(getSetting(db, 'stale_return_days'));
  const unpaidDays = Number(getSetting(db, 'payment_days_max'));

  const lastUploads = db
    .prepare(`SELECT kind, platform, COUNT(*) AS files, MAX(committed_at) AS last_committed, MAX(date_to) AS covers_to
                FROM imports WHERE status = 'committed' GROUP BY kind ORDER BY kind`)
    .all();

  // Days in the last two weeks with no invoices, per platform family: either nothing
  // sold or that day's PDF was never uploaded.
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(shift(today, -i));
  const invoiced = db
    .prepare(`SELECT ${FAM('o')} AS fam, COALESCE(invoice_date, order_date) AS d, COUNT(*) AS n
                FROM orders o WHERE COALESCE(invoice_date, order_date) >= ? AND source IS NOT 'order_report' GROUP BY fam, d`)
    .all(days[0]);
  const hit = new Set(invoiced.map((r) => `${r.fam}|${r.d}`));
  const anyInvoices = (fam) => invoiced.some((r) => r.fam === fam)
    || db.prepare(`SELECT 1 FROM orders o WHERE ${FAM('o')} = ? AND source IS NOT 'order_report' LIMIT 1`).get(fam);
  const missingInvoiceDays = ['flipkart', 'meesho']
    .filter((fam) => anyInvoices(fam))
    .map((fam) => ({ platform: fam, days: days.filter((d) => !hit.has(`${fam}|${d}`)) }));

  // Unpaid means past the last day of the window (day 15 can still pay), and only once
  // the payment files cover the day the payment was due by: an order due before the
  // first imported payment was settled before the history.
  const unpaidWhere = `o.cancelled = 0 AND COALESCE(o.invoice_date, o.order_date) < @cutoff
                 AND date(COALESCE(o.invoice_date, o.order_date), '+' || @days || ' days')
                     >= (SELECT MIN(s.payment_date) FROM settlement_lines s WHERE ${FAM('s')} = ${FAM('o')})
                 AND NOT EXISTS (SELECT 1 FROM settlement_lines s WHERE ${FAM('s')} = ${FAM('o')} AND s.order_item_key = o.order_item_key)
                 AND NOT EXISTS (SELECT 1 FROM returns r WHERE ${FAM('r')} = ${FAM('o')} AND r.order_item_key = o.order_item_key)`;
  const unpaidArgs = { cutoff: shift(today, -unpaidDays), days: unpaidDays };
  const unpaid = db
    .prepare(`SELECT o.platform, o.order_item_key, o.sku, COALESCE(o.invoice_date, o.order_date) AS sale_date, o.total_paise
                FROM orders o WHERE ${unpaidWhere} ORDER BY sale_date LIMIT 500`)
    .all(unpaidArgs);
  const unpaidCount = db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${unpaidWhere}`).get(unpaidArgs).n;

  const staleReturns = db
    .prepare(`SELECT platform, return_key, order_item_key, sku, return_type, reason, created_date, raw_status
                FROM returns WHERE status = 'open' AND created_date IS NOT NULL AND created_date <= ?
               ORDER BY created_date LIMIT 500`)
    .all(shift(today, -staleDays));

  const noInvoiceWhere = `s.order_item_key IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM orders o WHERE ${FAM('o')} = ${FAM('s')} AND o.order_item_key = s.order_item_key
                                   AND o.source IS NOT 'order_report')`;
  const paymentsWithoutInvoice = db
    .prepare(`SELECT s.platform, s.order_item_key, s.sku, s.payment_date, s.net_paise
                FROM settlement_lines s WHERE ${noInvoiceWhere}
               ORDER BY s.payment_date DESC LIMIT 500`)
    .all();
  // The list is capped for the page; the count is not.
  const paymentsWithoutInvoiceCount = db
    .prepare(`SELECT COUNT(DISTINCT s.order_item_key) AS n FROM settlement_lines s WHERE ${noInvoiceWhere}`)
    .get().n;

  const codesWithoutCost = db
    .prepare('SELECT s.code, s.display_code FROM sku_codes s WHERE NOT EXISTS (SELECT 1 FROM costs c WHERE c.code = s.code) ORDER BY s.code')
    .all();

  const dispatchWithoutRecipe = db
    .prepare(`SELECT o.code, COUNT(*) AS n FROM orders o
               LEFT JOIN v_code_resolved rc ON rc.raw = o.code
               WHERE o.cancelled = 0 AND (rc.code IS NULL OR NOT EXISTS (SELECT 1 FROM pack_recipes r WHERE r.code = rc.code))
               GROUP BY o.code`)
    .all();

  const rejected = db
    .prepare(`SELECT r.import_id, i.file_name, r.row_no, r.reason FROM import_rows_rejected r
                JOIN imports i ON i.id = r.import_id AND i.status = 'committed'
               ORDER BY r.import_id DESC LIMIT 500`)
    .all();

  const dupes = db
    .prepare("SELECT COALESCE(SUM(rows_unchanged + rows_batch_dupes), 0) AS n FROM imports WHERE status = 'committed'")
    .get().n;

  return {
    integrity: integrityCheck(db),
    lastUploads,
    missingInvoiceDays,
    unpaid: { days: unpaidDays, count: unpaidCount, rows: unpaid },
    staleReturns: { days: staleDays, count: staleReturns.length, rows: staleReturns },
    paymentsWithoutInvoice: { count: paymentsWithoutInvoiceCount, rows: paymentsWithoutInvoice },
    codesWithoutCost,
    unknownCodes: unknownCodes(db),
    recipeTodo: db.prepare('SELECT * FROM recipe_todo ORDER BY code').all(),
    dispatchWithoutRecipe,
    unconfirmedAliases: db.prepare('SELECT * FROM sku_aliases WHERE confirmed = 0').all(),
    negativeStock: db.prepare('SELECT stock_item_id, name, on_hand FROM v_stock_on_hand WHERE on_hand < 0').all(),
    noOpeningStock: db
      .prepare(`SELECT si.id, si.name FROM stock_items si
                 WHERE NOT EXISTS (SELECT 1 FROM stock_moves m WHERE m.stock_item_id = si.id AND m.kind = 'opening')`)
      .all().length,
    rejectedRows: rejected,
    duplicatesPrevented: dupes,
  };
}

function shift(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
