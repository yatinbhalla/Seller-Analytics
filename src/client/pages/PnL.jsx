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
  if (!data.total.payments) return <><PageHeader title="Profit breakdown" /><Empty>No payments in this range.</Empty></>;

  const selected = view === 'total' ? data.total : data.months.find((m) => `${m.month}|${m.platform}` === view);
  // Every step label that appears in any month, in waterfall order, profit last.
  const labels = [...new Set([...data.total.steps, ...data.months.flatMap((m) => m.steps)].map((s) => s.label))]
    .sort((a, b) => (a === '= Profit') - (b === '= Profit'));

  return (
    <Loading loading={loading}>
      <PageHeader title="Profit breakdown" subtitle="From what buyers paid down to profit, for the payments received in this range. The steps always add up to the profit.">
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
      {selected.costMissing > 0 && (
        <Notice>{n(selected.costMissing)} payments are for products with no cost price and are left out of profit.</Notice>
      )}
      <Card tone="green" title={view === 'total' ? `Whole range · ${n(selected.payments)} payments` : `${view.replace('|', ' · ')} · ${n(selected.payments)} payments`}>
        <Waterfall steps={selected.steps} />
        {selected.taxHeldPaise !== 0 && (
          <p className="mt-3 text-xs text-ink-2">
            The steps run before TCS/TDS. {rs(selected.taxHeldPaise)} was held back as TCS/TDS, so the bank received {rs(selected.bankPaise)}.
            You claim it back, so it is not a cost — see <Link to="/tax" className="text-series underline">TCS &amp; TDS</Link>.
          </p>
        )}
      </Card>

      <Card className="mt-4" title="Month by month (by payment date)">
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
