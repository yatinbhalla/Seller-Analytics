import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { qs, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { n, pct, PLATFORMS, rs } from '../lib/format.js';
import { Empty, ErrorBox, Input, Loading, Money, PageHeader, Select } from '../components/ui.jsx';

const METRICS = [
  { key: 'profit', label: 'Profit (payments)', fmt: rs, sortable: true },
  { key: 'received', label: 'Money received', fmt: rs },
  { key: 'gmv', label: 'Sales', fmt: rs },
  { key: 'lines', label: 'Order lines', fmt: n },
  { key: 'margin', label: 'Margin', fmt: pct },
  { key: 'returnRate', label: 'Return rate', fmt: pct },
  { key: 'rtoRate', label: 'RTO rate', fmt: pct },
  { key: 'profitPerUnit', label: 'Profit per paid sale', fmt: rs },
  { key: 'returnCost', label: 'Return cost', fmt: rs },
];

export default function Products() {
  const { filters } = useFilters();
  const { data, error, loading } = useApi(`/reports/products${qs(filters)}`);
  const [compare, setCompare] = useState(false);
  const [metric, setMetric] = useState('profit');
  const [open, setOpen] = useState({});
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: 'gmv', dir: -1 });

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.rows
      .filter((r) => !needle || `${r.name} ${r.category}`.toLowerCase().includes(needle))
      .sort((a, b) => ((a.metrics.all?.[sort.key] ?? -Infinity) - (b.metrics.all?.[sort.key] ?? -Infinity)) * sort.dir);
  }, [data, q, sort]);

  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;
  const m = METRICS.find((x) => x.key === metric);
  const shownPlatforms = PLATFORMS.filter((p) => !filters.platforms.length || filters.platforms.includes(p.key));
  const th = (key, label) => (
    <th className="r cursor-pointer select-none" onClick={() => setSort({ key, dir: sort.key === key ? -sort.dir : -1 })}>
      {label}
      {sort.key === key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}
    </th>
  );

  return (
    <Loading loading={loading}>
      <PageHeader title="Products" subtitle="Each product rolls up every pack size, every listing type and every platform. Open one to see its SKUs.">
        <div className="flex flex-wrap items-center gap-2">
          <Input placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="flex items-center gap-1.5 text-sm text-ink-2">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare platforms
          </label>
          {compare && (
            <Select value={metric} onChange={(e) => setMetric(e.target.value)} aria-label="Metric to compare">
              {METRICS.map((x) => (
                <option key={x.key} value={x.key}>{x.label}</option>
              ))}
            </Select>
          )}
        </div>
      </PageHeader>
      <ErrorBox error={error} />
      {!rows.length ? (
        <Empty>No product sold in this range.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                {compare ? (
                  <>
                    {shownPlatforms.map((p) => (
                      <th key={p.key} className="r">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
                          {p.label}
                        </span>
                      </th>
                    ))}
                    <th className="r">All</th>
                  </>
                ) : (
                  <>
                    {th('lines', 'Lines')}
                    {th('gmv', 'Sales')}
                    {th('received', 'Received')}
                    {th('profit', 'Profit')}
                    {th('margin', 'Margin')}
                    {th('returnRate', 'Returns')}
                    {th('rtoRate', 'RTO')}
                    {th('returnCost', 'Return cost')}
                    <th>Top return reason</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <Fragment key={p.key}>
                  <Row
                    depth={0}
                    open={open[p.key]}
                    onToggle={() => setOpen({ ...open, [p.key]: !open[p.key] })}
                    label={
                      <>
                        {p.id ? <Link to={`/products/${p.id}`} className="font-medium hover:underline">{p.name}</Link> : <span className="font-medium">{p.name}</span>}
                        <span className="ml-2 text-xs text-muted">{p.category}</span>
                      </>
                    }
                    metrics={p.metrics}
                    compare={compare}
                    metric={m}
                    platforms={shownPlatforms}
                    reason={p.reasons[0]?.reason}
                  />
                  {open[p.key] &&
                    p.variants.map((v) => (
                      <Fragment key={`${p.key}-${v.label}`}>
                        <Row depth={1} label={v.label} metrics={v.metrics} compare={compare} metric={m} platforms={shownPlatforms} />
                        {v.codes.map((c) => (
                          <Fragment key={c.code}>
                            <Row
                              depth={2}
                              label={
                                <span className="font-mono text-xs">
                                  {c.code}
                                  {c.resolvedTo && c.resolvedTo !== c.code && <span className="text-muted"> → {c.resolvedTo}</span>}
                                  <span className="ml-2 font-sans text-muted">{c.listings.length} listing copies sold</span>
                                </span>
                              }
                              metrics={c.metrics}
                              compare={compare}
                              metric={m}
                              platforms={shownPlatforms}
                            />
                          </Fragment>
                        ))}
                      </Fragment>
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Loading>
  );
}

function Row({ depth, label, metrics, compare, metric, platforms, open, onToggle, reason }) {
  const a = metrics.all || {};
  return (
    <tr className={depth ? 'text-ink-2' : ''}>
      <td style={{ paddingLeft: 8 + depth * 20 }}>
        {onToggle && (
          <button onClick={onToggle} className="mr-1 w-4 text-muted" aria-expanded={!!open} aria-label={open ? 'Collapse' : 'Expand'}>
            {open ? '▾' : '▸'}
          </button>
        )}
        {label}
      </td>
      {compare ? (
        <>
          {platforms.map((p) => (
            <td key={p.key} className="r">{metrics[p.key] ? metric.fmt(metrics[p.key][metric.key]) : '—'}</td>
          ))}
          <td className="r font-medium">{metric.fmt(a[metric.key])}</td>
        </>
      ) : (
        <>
          <td className="r">{n(a.lines)}</td>
          <td className="r">{rs(a.gmv)}</td>
          <td className="r">{rs(a.received)}</td>
          <td className="r">{a.paidSales ? <Money paise={a.profit} /> : '—'}</td>
          <td className="r">{pct(a.margin)}</td>
          <td className="r">{pct(a.customerReturnRate)}</td>
          <td className="r">{pct(a.rtoRate)}</td>
          <td className="r">{rs(a.returnCost)}</td>
          <td className="text-ink-2">{reason || ''}</td>
        </>
      )}
    </tr>
  );
}
