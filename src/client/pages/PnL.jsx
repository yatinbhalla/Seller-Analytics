import { useMemo, useState } from 'react';
import { qs, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { Link } from 'react-router';
import { n, platformLabel, rs } from '../lib/format.js';
import { Card, Empty, ErrorBox, Loading, Notice, PageHeader, Select } from '../components/ui.jsx';
import { Waterfall } from '../components/Charts.jsx';

export default function PnL() {
  const { filters } = useFilters();
  const { data, error, loading } = useApi(`/reports/pnl${qs(filters)}`);
  const [view, setView] = useState('total');

  const months = useMemo(() => (data ? [...new Set(data.months.map((m) => m.month))].sort().reverse() : []), [data]);
  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;
  if (!data.total.lines) return <><PageHeader title="Profit & loss" /><Empty>No orders in this range.</Empty></>;

  const selected = view === 'total' ? data.total : data.months.find((m) => `${m.month}|${m.platform}` === view);
  // Every step label that appears in any month, in waterfall order, profit last.
  const labels = [...new Set([...data.total.steps, ...data.months.flatMap((m) => m.steps)].map((s) => s.label))]
    .sort((a, b) => (a === '= Profit') - (b === '= Profit'));

  return (
    <Loading loading={loading}>
      <PageHeader title="Profit & loss" subtitle="From invoiced sales down to profit. Every bar is a real figure, and the steps always add up to the profit.">
        <Select value={view} onChange={(e) => setView(e.target.value)} aria-label="Period">
          <option value="total">Whole range</option>
          {data.months.map((m) => (
            <option key={`${m.month}|${m.platform}`} value={`${m.month}|${m.platform}`}>
              {m.month} · {m.platform === 'all' ? 'all platforms' : platformLabel(m.platform)}
            </option>
          ))}
        </Select>
      </PageHeader>
      <ErrorBox error={error} />
      {(selected.costMissingLines > 0 || selected.estimatedLines > 0) && (
        <Notice>
          {selected.estimatedLines > 0 && <>{n(selected.estimatedLines)} lines use estimated payouts until their settlement is imported. </>}
          {selected.costMissingLines > 0 && <>{n(selected.costMissingLines)} lines have no cost price and are left out of profit.</>}
        </Notice>
      )}
      <Card title={view === 'total' ? 'Whole range' : view.replace('|', ' · ')}>
        <Waterfall steps={selected.steps} />
        {selected.taxHeldPaise > 0 && (
          <p className="mt-3 text-xs text-ink-2">
            Payout is shown before TCS/TDS. {rs(selected.taxHeldPaise)} of it is held back as TCS/TDS
            {selected.taxHeldEstimatedPaise > 0 && <> ({rs(selected.taxHeldEstimatedPaise)} of that estimated, on orders not paid yet)</>}, so the
            bank amount is {rs(selected.bankPayoutPaise)}. You claim it back, so it is not a cost — see{' '}
            <Link to="/tax" className="text-series underline">TCS &amp; TDS</Link>.
          </p>
        )}
      </Card>

      <Card className="mt-4" title="Month by month">
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th />
                {months.map((m) => <th key={m} className="r">{m}</th>)}
              </tr>
            </thead>
            <tbody>
              {labels.map((label) => (
                <tr key={label} className={label.startsWith('=') ? 'font-semibold' : ''}>
                  <td className="whitespace-nowrap">{label}</td>
                  {months.map((m) => {
                    const row = data.months.find((x) => x.month === m && x.platform === 'all');
                    const step = row?.steps.find((s) => s.label === label);
                    return <td key={m} className="r">{step ? rs(step.value) : '—'}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Loading>
  );
}
