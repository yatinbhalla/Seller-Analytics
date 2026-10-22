import { Link } from 'react-router';
import { qs, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { n, pct, rs } from '../lib/format.js';
import { Card, Empty, Status } from './ui.jsx';

const KIND = { high: 'bad', medium: 'warn', info: 'info' };

/** The Overview's first card: odd figures in the files, and the gaps worth chasing. */
export function NeedsAttention() {
  const { filters } = useFilters();
  const { data } = useApi(`/reports/alerts${qs(filters)}`);
  if (!data) return null;
  const { counts, byType, gaps } = data;
  const top = data.items.filter((i) => i.severity !== 'info').slice(0, 5);
  const quiet = !counts.high && !counts.medium && !gaps.overduePayments.lines && !gaps.staleReturns.count;

  return (
    <Card className="mb-4" title="Needs attention" action={<Link to="/alerts" className="text-sm text-ink-2 underline">All alerts</Link>}>
      {quiet ? (
        <Status kind="good">Nothing odd in your files{counts.info ? ` (${n(counts.info)} info notes)` : ''}.</Status>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ul className="space-y-1.5 text-sm">
            {byType.filter((t) => t.severity !== 'info').map((t) => (
              <li key={t.type} className="flex items-baseline justify-between gap-3">
                <Status kind={KIND[t.severity]}>{t.label}</Status>
                <span className="num whitespace-nowrap text-ink-2">{n(t.count)}{t.amountPaise ? ` · ${rs(t.amountPaise)}` : ''}</span>
              </li>
            ))}
            {gaps.overduePayments.lines > 0 && (
              <li className="flex items-baseline justify-between gap-3">
                <Status kind="warn">Payments overdue</Status>
                <span className="num text-ink-2">{n(gaps.overduePayments.lines)} · {rs(gaps.overduePayments.paise)}</span>
              </li>
            )}
            {gaps.staleReturns.count > 0 && (
              <li className="flex items-baseline justify-between gap-3">
                <Status kind="warn">Returns open {gaps.staleReturns.days}+ days</Status>
                <span className="num text-ink-2">{n(gaps.staleReturns.count)}</span>
              </li>
            )}
          </ul>
          {top.length > 0 && (
            <ul className="space-y-1.5 text-sm">
              {top.map((i) => (
                <li key={i.key} className="border-l-2 border-line pl-2">
                  <div className="text-ink">{i.title}</div>
                  <div className="text-xs text-muted">{i.label}{i.orderId ? ` · ${i.orderId}` : ''}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
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
    <Card title="Areas with the most returns" action={<Link to="/returns" className="text-sm text-ink-2 underline">By area</Link>}>
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
