import { Link } from 'react-router';
import { qs, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { n, pct, rs } from '../lib/format.js';
import { Card, Empty, PriorityBadge, Status } from './ui.jsx';

/** Home's attention list: odd figures in the files and the gaps worth chasing, most urgent first. */
export function NeedsAttention() {
  const { filters } = useFilters();
  const { data } = useApi(`/reports/alerts${qs(filters)}`);
  if (!data) return null;
  const { counts, byType, gaps } = data;
  const rows = [
    ...byType.filter((t) => t.severity !== 'info').map((t) => ({ key: t.type, level: t.severity, label: t.label, count: t.count, paise: t.amountPaise })),
    ...(gaps.overduePayments.lines ? [{ key: 'overdue', level: 'medium', label: 'Payments overdue', count: gaps.overduePayments.lines, paise: gaps.overduePayments.paise, to: '/payments/due' }] : []),
    ...(gaps.staleReturns.count ? [{ key: 'stale', level: 'medium', label: `Returns open ${gaps.staleReturns.days}+ days`, count: gaps.staleReturns.count, to: '/returns' }] : []),
  ].sort((a, b) => (a.level === b.level ? 0 : a.level === 'high' ? -1 : 1));

  return (
    <Card title="Needs attention" tone={counts.high ? 'red' : rows.length ? 'amber' : 'green'} action={<Link to="/alerts" className="text-sm text-ink-2 underline">All alerts</Link>}>
      {!rows.length ? (
        <Status kind="good">Nothing odd in your files{counts.info ? ` (${n(counts.info)} info notes)` : ''}.</Status>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-3 py-2">
              <PriorityBadge level={r.level} />
              <Link to={r.to || '/alerts'} className="min-w-0 flex-1 truncate text-ink hover:underline">{r.label}</Link>
              <span className="num whitespace-nowrap text-ink-2">{n(r.count)}{r.paise ? ` · ${rs(r.paise)}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** States and PIN codes returning more than the average, with enough orders to count. */
export function ReturnAreas() {
  const { filters } = useFilters();
  const { data: states } = useApi(`/reports/areas${qs(filters, { level: 'state' })}`);
  const { data: pins } = useApi(`/reports/areas${qs(filters, { level: 'pincode' })}`);
  if (!states || !pins) return null;
  const hot = (r) => r.rows.filter((x) => x.aboveAverage).sort((a, b) => b.returnRate - a.returnRate).slice(0, 5);
  const list = [...hot(states).map((x) => ({ ...x, kind: 'State' })), ...hot(pins).map((x) => ({ ...x, kind: 'PIN' }))];

  return (
    <Card title="Areas with the most returns" tone="coral" action={<Link to="/returns" className="text-sm text-ink-2 underline">By area</Link>}>
      {!list.length ? (
        <Empty>No area stands out yet. An area needs {states.minOrders}+ orders and a return rate above your {pct(states.total.returnRate)} average.</Empty>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {list.map((x) => (
            <li key={`${x.kind}|${x.key}`} className="flex items-baseline justify-between gap-3">
              <span><span className="text-xs text-muted">{x.kind}</span> {x.key}</span>
              <span className="num whitespace-nowrap text-ink-2">{pct(x.returnRate)} of {n(x.orders)} · {x.vsAverage?.toFixed(1)}×</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
