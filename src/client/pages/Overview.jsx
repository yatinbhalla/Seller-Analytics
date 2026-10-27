import { useState } from 'react';
import { Link } from 'react-router';
import { qs, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { n, pct, platformLabel, rs } from '../lib/format.js';
import { Card, Empty, ErrorBox, Loading, Money, Notice, PageHeader, Tile } from '../components/ui.jsx';
import { TrendChart } from '../components/Charts.jsx';
import { NeedsAttention } from '../components/NeedsAttention.jsx';

/**
 * Home: the four numbers that matter, then what needs attention. Money and profit come
 * from the payments received in the range; orders sent in the range sit apart, below.
 */
export default function Overview() {
  const { filters } = useFilters();
  const { data, error, loading } = useApi(`/reports/overview${qs(filters)}`);
  const { data: due } = useApi(`/reports/payments-due${qs({ platforms: filters.platforms, categoryId: filters.categoryId })}`);
  const { data: alerts } = useApi(`/reports/alerts${qs(filters)}`);
  const [measure, setMeasure] = useState('profit');

  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;
  const m = data.money;
  const t = data.total;
  if (!m.payments && !t.lines) {
    return (
      <>
        <PageHeader title="Home" />
        <Empty>
          Nothing in this range yet. <Link to="/import" className="text-series underline">Import your payment files and invoice PDFs</Link> to get started.
        </Empty>
      </>
    );
  }
  const toCome = due ? due.notDue.paise + due.dueNow.paise : null;
  const high = alerts?.counts.high || 0;
  const medium = alerts?.counts.medium || 0;
  const overdue = due?.overdue.lines || 0;

  return (
    <Loading loading={loading}>
      <PageHeader title="Home" subtitle="Money and profit from the payments received in this range" />
      <ErrorBox error={error} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile tone="green" label="Money received" value={rs(m.net)} sub={`${n(m.payments)} payments`} />
        <Tile tone={m.profit < 0 ? 'red' : 'teal'} label="Profit from payments" value={rs(m.profit)} sub={m.margin == null ? '—' : `${pct(m.margin)} of money received`} />
        <Tile tone="amber" label="Money to come" value={toCome == null ? '…' : rs(toCome)} sub={due ? `${n(due.notDue.lines + due.dueNow.lines)} orders not paid yet` : ''} />
        <Tile
          tone={high ? 'red' : medium || overdue ? 'amber' : 'green'}
          label="Needs attention"
          value={alerts ? (high || medium ? `${n(high + medium)} to check` : 'All clear') : '…'}
          sub={`${n(high)} high · ${n(medium)} medium${overdue ? ` · ${rs(due.overdue.paise)} overdue` : ''}`}
        />
      </div>

      {m.costMissing > 0 && (
        <Notice tone="amber">
          {n(m.costMissing)} payments are for products with no cost price, so they are left out of profit —{' '}
          <Link to="/health" className="underline">add the cost in Data health</Link>.
        </Notice>
      )}

      <div className="mt-4">
        <NeedsAttention />
      </div>

      <Card
        className="mt-4"
        tone="green"
        title={measure === 'profit' ? 'Profit by payment day' : 'Money received by day'}
        action={
          <div className="flex gap-1 text-xs">
            {[
              ['profit', 'Profit'],
              ['received', 'Received'],
            ].map(([k, l]) => (
              <button key={k} onClick={() => setMeasure(k)} className={`rounded-md px-2 py-1 ${measure === k ? 'bg-green-100 font-medium text-green-950 dark:bg-green-950 dark:text-green-100' : 'text-ink-2'}`}>
                {l}
              </button>
            ))}
          </div>
        }
      >
        <TrendChart rows={data.trend} measure={measure} platforms={filters.platforms} empty="No payments in this range." />
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Most profitable products" tone="green" action={<Link to="/payments" className="text-sm text-ink-2 underline">By SKU</Link>}>
          <ProductList rows={data.best} />
        </Card>
        <Card title="Least profitable products" tone="red">
          <ProductList rows={data.worst} />
        </Card>
      </div>

      <Card className="mt-4" tone="blue" title="Orders sent in this range" action={<Link to="/orders" className="text-sm text-ink-2 underline">Orders</Link>}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-5">
          <Figure label="Orders" value={n(t.lines)} />
          <Figure label="Sales" value={rs(t.gmv)} />
          <Figure label="Customer returns" value={pct(t.customerReturnRate)} />
          <Figure label="RTO" value={pct(t.rtoRate)} />
          <Figure label="Top return reason" value={t.topReason?.reason || '—'} />
        </div>
      </Card>
      {filters.platforms.length > 0 && (
        <p className="mt-3 text-xs text-muted">Showing {filters.platforms.map(platformLabel).join(', ')} only.</p>
      )}
    </Loading>
  );
}

function Figure({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className="truncate font-medium text-ink" title={typeof value === 'string' ? value : undefined}>{value}</div>
    </div>
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
              <div className="text-xs text-muted">{n(p.sales)} paid sales{p.returns ? ` · ${n(p.returns)} returns and RTO` : ''}</div>
            </td>
            <td className="r"><Money paise={p.profit} /></td>
            <td className="r text-ink-2">{pct(p.margin)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
