import { Link } from 'react-router';
import { qs, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { n, niceDate, rs } from '../lib/format.js';
import { Card, Empty, ErrorBox, PageHeader, Tile } from '../components/ui.jsx';

/**
 * Money still to come. Payment lands 7–15 days after dispatch, so each order not paid
 * yet is either not due, due any day now, or overdue — the overdue ones are the ones
 * to chase with the marketplace. These orders carry no profit until they are paid.
 */
export default function MoneyToCome() {
  const { filters } = useFilters();
  const { data, error } = useApi(`/reports/payments-due${qs({ platforms: filters.platforms, categoryId: filters.categoryId })}`);
  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;
  const peak = Math.max(1, ...data.byDay.map((d) => d.paise));
  return (
    <>
      <PageHeader title="Money to come" subtitle={`Orders not paid yet. Payment usually lands ${data.min}–${data.max} days after dispatch. They earn their profit when paid.`} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile tone="green" label="Due now (inside the window)" value={rs(data.dueNow.paise)} sub={`${n(data.dueNow.lines)} orders · can land any day`} />
        <Tile tone="blue" label="Not due yet" value={rs(data.notDue.paise)} sub={`${n(data.notDue.lines)} orders dispatched under ${data.min} days ago`} />
        <Tile
          tone={data.overdue.lines ? 'red' : 'gray'}
          label={`Overdue (over ${data.max} days)`}
          value={rs(data.overdue.paise)}
          sub={data.overdue.lines ? <Link to="/health" className="underline">{n(data.overdue.lines)} orders to chase</Link> : 'none'}
        />
      </div>
      {data.beforePaymentFiles.lines > 0 && (
        <p className="mt-3 text-xs text-muted">
          Not counted: {n(data.beforePaymentFiles.lines)} unpaid orders ({rs(data.beforePaymentFiles.paise)}) whose payment was due before your
          imported payment files begin{Object.keys(data.paymentFilesFrom).length
            ? ` (${Object.entries(data.paymentFilesFrom).map(([p, d]) => `${p === 'meesho' ? 'Meesho' : 'Flipkart'} ${niceDate(d)}`).join(', ')})`
            : ''}. They were most likely paid then.
        </p>
      )}
      {data.byDay.length > 0 && (
        <Card className="mt-4" tone="amber" title={`Expected by day — next 7 days ${rs(data.next7Paise)}`}>
          <div className="mb-1 text-xs text-muted">Estimated payouts, spread over each order's payment window</div>
          <div className="flex h-24 items-end gap-[2px]" role="img" aria-label="Expected payments by day">
            {data.byDay.map((d) => (
              <div key={d.day} className="flex-1" title={`${niceDate(d.day)}: ${rs(d.paise)}`}>
                <div className="rounded-t-sm bg-amber-400 dark:bg-amber-600" style={{ height: `${Math.max(2, (d.paise / peak) * 96)}px` }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted">
            <span>{niceDate(data.byDay[0].day)}</span>
            <span>{niceDate(data.byDay[data.byDay.length - 1].day)}</span>
          </div>
        </Card>
      )}
    </>
  );
}
