import { useState } from 'react';
import { api, qs, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { n, niceDate, pct, PLATFORMS, rs } from '../lib/format.js';
import { Card, Empty, ErrorBox, Loading, Notice, PageHeader, PlatformTag, Select, Stat } from '../components/ui.jsx';
import { Legend } from '../components/Charts.jsx';
import AreaReturns from '../components/AreaReturns.jsx';

export default function Returns() {
  const { filters } = useFilters();
  const { data, error, loading, reload } = useApi(`/reports/returns${qs(filters)}`);
  const [show, setShow] = useState('all');
  const [saveError, setSaveError] = useState(null);

  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;
  const t = data.total;
  const rows = data.rows.filter((r) => show === 'all' || (show === 'open' ? r.status !== 'closed' : r.status === 'closed'));
  const platforms = PLATFORMS.filter((p) => data.reasons.some((r) => r[p.key]));

  const setCondition = async (r, condition) => {
    setSaveError(null);
    try {
      await api('/returns/condition', { method: 'PATCH', body: { naturalKey: naturalKeyOf(r), condition } });
      reload();
    } catch (err) {
      setSaveError(err.message);
    }
  };

  return (
    <Loading loading={loading}>
      <PageHeader title="Returns" subtitle={`${n(t.returns)} returns · ${n(data.soldLines)} order lines sold in this range`} />
      <ErrorBox error={error || saveError} />
      {data.beforeHistory > 0 && (
        <Notice>
          {n(data.beforeHistory)} of these returns are for sales from before your first upload. They count in reasons and totals here, but return
          rates use only sales the app has a record of, and their cost is left out until their payment line is imported.
        </Notice>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Customer returns" value={n(t.returnsCustomer)} sub={`${pct(t.customerReturnRate)} of sales on record`} />
        <Stat label="RTO" value={n(t.returnsRto)} sub={`${pct(t.rtoRate)} of sales on record`} />
        <Stat label="Still in transit" value={n(t.returnsOpen)} />
        <Stat label="Return cost" value={rs(t.returnCost)} sub={`incl. ${rs(t.packagingOnReturns)} packaging lost`} />
        <Stat label="Avg days to close" value={data.avgDaysToClose ?? '—'} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Reasons by platform">
          {!data.reasons.length ? <Empty>No returns.</Empty> : (
            <>
              <Legend items={platforms.map((p) => ({ label: p.label, color: p.color }))} />
              <ul className="space-y-2">
                {data.reasons.slice(0, 12).map((r) => (
                  <li key={r.reason} className="text-sm">
                    <div className="flex justify-between gap-3">
                      <span className="truncate text-ink" title={r.reason}>{r.reason}</span>
                      <span className="num text-ink-2">{n(r.total)}</span>
                    </div>
                    <div className="mt-1 flex h-2 gap-[2px]">
                      {platforms.map((p) => r[p.key] ? (
                        <div key={p.key} title={`${p.label}: ${r[p.key]}`} className="h-2 first:rounded-l-sm last:rounded-r-sm" style={{ width: `${(r[p.key] / data.reasons[0].total) * 100}%`, background: p.color }} />
                      ) : null)}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
        <Card title="Products with the highest return cost">
          {!data.perProduct.length ? <Empty>No returns.</Empty> : (
            <table className="data">
              <thead><tr><th>Product</th><th className="r">Returns</th><th className="r">Rate</th><th className="r">Cost</th><th>Top reason</th></tr></thead>
              <tbody>
                {data.perProduct.slice(0, 12).map((p) => (
                  <tr key={p.key}><td>{p.name}</td><td className="r">{n(p.returns)}</td><td className="r">{pct(p.rate)}</td><td className="r">{rs(p.returnCost)}</td><td className="text-ink-2">{p.topReason?.reason || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card
        className="mt-4"
        title="Every return"
        action={
          <Select value={show} onChange={(e) => setShow(e.target.value)} aria-label="Show">
            <option value="all">All</option><option value="open">In transit</option><option value="closed">Closed</option>
          </Select>
        }
      >
        {!rows.length ? <Empty>None.</Empty> : (
          <div className="max-h-[32rem] overflow-auto">
            <table className="data">
              <thead>
                <tr><th>Created</th><th>Platform</th><th>SKU</th><th>Product</th><th>Type</th><th>Reason</th><th>Status</th><th className="r">Cost</th><th>Condition</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.platform}-${r.itemKey}`}>
                    <td className="whitespace-nowrap">{niceDate(r.created)}</td>
                    <td><PlatformTag platform={r.platform} /></td>
                    <td className="font-mono text-xs">{r.sku}</td>
                    <td>{r.product}</td>
                    <td>{r.type === 'rto' ? 'RTO' : 'Customer'}</td>
                    <td>{r.reason || '—'}{r.subReason && <div className="text-xs text-muted">{r.subReason}</div>}{r.comments && <div className="text-xs italic text-muted">“{r.comments}”</div>}</td>
                    <td className="whitespace-nowrap">{r.status === 'closed' ? `${r.outcome} ${niceDate(r.closed)}` : 'in transit'}</td>
                    <td className="r">{r.beforeHistory ? <span className="text-xs text-muted">sold before history</span> : <>{rs(r.returnCostPaise)}{r.estimated && <div className="text-[11px] text-muted">estimated</div>}</>}</td>
                    <td>
                      {r.status === 'closed' && r.outcome === 'received' ? (
                        <Select value={r.condition || ''} onChange={(e) => setCondition(r, e.target.value || null)} aria-label="Condition">
                          <option value="">Good (default)</option>
                          <option value="good">Good</option>
                          <option value="damaged">Damaged</option>
                          <option value="missing">Missing item</option>
                        </Select>
                      ) : <span className="text-xs text-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <AreaReturns />
    </Loading>
  );
}

function naturalKeyOf(r) {
  return `${r.platform === 'meesho' ? 'meesho' : 'flipkart'}|main|${r.returnKey}`;
}
