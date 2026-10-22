import { useState } from 'react';
import { Link } from 'react-router';
import { qs, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { n, niceDate, pct, platformLabel, rs } from '../lib/format.js';
import { Card, Empty, ErrorBox, Loading, Notice, PageHeader, PlatformTag, Stat } from '../components/ui.jsx';
import { RankBars, TrendChart } from '../components/Charts.jsx';

export default function Overview() {
  const { filters } = useFilters();
  const { data, error, loading } = useApi(`/reports/overview${qs(filters)}`);
  const [measure, setMeasure] = useState('gmv');

  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;
  const t = data.total;
  if (!t.lines) {
    return (
      <>
        <PageHeader title="Overview" />
        <Empty>
          No orders in this range yet. <Link to="/import" className="text-series underline">Import your invoice PDFs</Link> to get started.
        </Empty>
      </>
    );
  }

  return (
    <Loading loading={loading}>
      <PageHeader title="Overview" subtitle={`${n(t.lines)} order lines · ${n(t.units)} units`} />
      <ErrorBox error={error} />
      {(t.costMissingLines > 0 || t.estimatedLines > 0 || t.noInvoiceLines > 0 || t.returnsBeforeHistory > 0) && (
        <Notice>
          {t.estimatedLines > 0 && <>{n(t.estimatedLines)} lines are not settled yet, so their payout is <b>estimated</b> from similar settled orders. </>}
          {t.noInvoiceLines > 0 && <>{n(t.noInvoiceLines)} lines come from payment files with no invoice PDF uploaded — their GST is estimated and they do not move stock. </>}
          {t.returnsBeforeHistory > 0 && <>{n(t.returnsBeforeHistory)} returns are for sales from before your first upload; they count in return reasons but not in money or return rates. </>}
          {t.costMissingLines > 0 && (
            <>
              {n(t.costMissingLines)} lines have no cost price and are left out of profit —{' '}
              <Link to="/health" className="text-series underline">fix in Data health</Link>.
            </>
          )}
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Sales" value={rs(t.gmv)} sub={`Net of returns ${rs(t.netSales)}`} />
        <Stat label="Payout" value={rs(t.payout)} sub={t.estimatedLines ? `incl. ${rs(t.payoutEstimated)} estimated` : 'all settled'} />
        <Stat label="Profit" value={rs(data.profitAfterAds)} sub={`Margin ${pct(t.netSales > 0 ? data.profitAfterAds / t.netSales : null)}${data.ads ? ` · after ${rs(-data.ads)} ads` : ''}`} tone={data.profitAfterAds < 0 ? 'bad' : undefined} />
        <Stat label="Return rate" value={pct(t.returnRate)} sub={`Customer ${pct(t.customerReturnRate)} · RTO ${pct(t.rtoRate)}`} />
        <Stat label="Return cost" value={rs(t.returnCost)} sub={`${pct(t.returnMarginHit)} of net sales`} />
      </div>

      <Card
        className="mt-4"
        title={measure === 'gmv' ? 'Daily sales by platform' : 'Daily profit by platform'}
        action={
          <div className="flex gap-1 text-xs">
            {[
              ['gmv', 'Sales'],
              ['profit', 'Profit'],
            ].map(([k, l]) => (
              <button key={k} onClick={() => setMeasure(k)} className={`rounded px-2 py-1 ${measure === k ? 'bg-wash font-medium text-ink' : 'text-ink-2'}`}>
                {l}
              </button>
            ))}
          </div>
        }
      >
        <TrendChart rows={data.trend} measure={measure} platforms={filters.platforms} />
      </Card>

      <PaymentsDue filters={filters} />

      <Card className="mt-4" title="By platform">
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Platform</th>
                <th className="r">Lines</th>
                <th className="r">Sales</th>
                <th className="r">Payout</th>
                <th className="r">Profit</th>
                <th className="r">Margin</th>
                <th className="r">Customer returns</th>
                <th className="r">RTO</th>
                <th className="r">Return cost</th>
                <th>Top return reason</th>
              </tr>
            </thead>
            <tbody>
              {data.platforms.map((p) => (
                <tr key={p.key}>
                  <td><PlatformTag platform={p.key} /></td>
                  <td className="r">{n(p.lines)}</td>
                  <td className="r">{rs(p.gmv)}</td>
                  <td className="r">{rs(p.payout)}</td>
                  <td className={`r ${p.profit < 0 ? 'text-bad' : ''}`}>{rs(p.profit)}</td>
                  <td className="r">{pct(p.margin)}</td>
                  <td className="r">{pct(p.customerReturnRate)}</td>
                  <td className="r">{pct(p.rtoRate)}</td>
                  <td className="r">{rs(p.returnCost)}</td>
                  <td className="text-ink-2">{p.topReason?.reason || '—'}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td>All platforms</td>
                <td className="r">{n(t.lines)}</td>
                <td className="r">{rs(t.gmv)}</td>
                <td className="r">{rs(t.payout)}</td>
                <td className="r">{rs(t.profit)}</td>
                <td className="r">{pct(t.margin)}</td>
                <td className="r">{pct(t.customerReturnRate)}</td>
                <td className="r">{pct(t.rtoRate)}</td>
                <td className="r">{rs(t.returnCost)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Most profitable products">
          <ProductList rows={data.best} />
        </Card>
        <Card title="Least profitable products">
          <ProductList rows={data.worst} />
        </Card>
        <Card title="Top return reasons">
          {data.topReasons.length ? <RankBars rows={data.topReasons} label={(r) => r.reason} value={(r) => r.count} format={n} /> : <Empty>No returns.</Empty>}
        </Card>
      </div>
      {filters.platforms.length > 0 && (
        <p className="mt-3 text-xs text-muted">Showing {filters.platforms.map(platformLabel).join(', ')} only.</p>
      )}
    </Loading>
  );
}

function ProductList({ rows }) {
  if (!rows.length) return <Empty>Nothing yet.</Empty>;
  return (
    <table className="data">
      <tbody>
        {rows.map((p) => (
          <tr key={p.key}>
            <td>
              {typeof p.key === 'number' ? <Link to={`/products/${p.key}`} className="hover:underline">{p.name}</Link> : p.name}
            </td>
            <td className={`r ${p.profit < 0 ? 'text-bad' : ''}`}>{rs(p.profit)}</td>
            <td className="r text-ink-2">{pct(p.margin)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Money still to come. Payment lands 7–15 days after dispatch, so each unsettled order
 * is either not due yet, due any day now, or overdue — the overdue ones are the ones
 * to chase with the marketplace.
 */
function PaymentsDue({ filters }) {
  const { data } = useApi(`/reports/payments-due${qs({ platforms: filters.platforms, categoryId: filters.categoryId })}`);
  if (!data || data.notDue.lines + data.dueNow.lines + data.overdue.lines === 0) return null;
  const peak = Math.max(1, ...data.byDay.map((d) => d.paise));
  return (
    <Card className="mt-4" title={`Payments on the way — paid ${data.min}–${data.max} days after dispatch`}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Due now (inside the window)" value={rs(data.dueNow.paise)} sub={`${n(data.dueNow.lines)} orders · can land any day`} />
        <Stat label="Not due yet" value={rs(data.notDue.paise)} sub={`${n(data.notDue.lines)} orders dispatched under ${data.min} days ago`} />
        <Stat
          label={`Overdue (over ${data.max} days)`}
          value={rs(data.overdue.paise)}
          sub={data.overdue.lines ? <Link to="/health" className="text-series underline">{n(data.overdue.lines)} orders to chase</Link> : 'none'}
          tone={data.overdue.lines ? 'bad' : undefined}
        />
      </div>
      {data.byDay.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-xs text-muted">Expected by day (estimated payouts, spread over each order's window) — next 7 days {rs(data.next7Paise)}</div>
          <div className="flex h-20 items-end gap-[2px]" role="img" aria-label="Expected payments by day">
            {data.byDay.map((d) => (
              <div key={d.day} className="group relative flex-1" title={`${niceDate(d.day)}: ${rs(d.paise)}`}>
                <div className="rounded-t-sm bg-series" style={{ height: `${Math.max(2, (d.paise / peak) * 80)}px` }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted">
            <span>{niceDate(data.byDay[0].day)}</span>
            <span>{niceDate(data.byDay[data.byDay.length - 1].day)}</span>
          </div>
        </div>
      )}
    </Card>
  );
}
