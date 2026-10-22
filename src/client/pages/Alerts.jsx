import { useState } from 'react';
import { Link } from 'react-router';
import { api, qs, useApi } from '../lib/api.js';
import { useFilters } from '../lib/filters.jsx';
import { n, niceDate, rs } from '../lib/format.js';
import { Button, Card, Empty, ErrorBox, Loading, PageHeader, PlatformTag, Select, Stat, Status } from '../components/ui.jsx';

export const SEVERITY = {
  high: { kind: 'bad', label: 'High' },
  medium: { kind: 'warn', label: 'Medium' },
  info: { kind: 'info', label: 'Info' },
};

/**
 * Alerts: figures in the files that look wrong, each with what to do about it.
 * "OK" hides an alert for good; "Follow up" pins it to the top until it is cleared.
 */
export default function Alerts() {
  const { filters } = useFilters();
  const [type, setType] = useState('');
  const [severity, setSeverity] = useState('');
  const [showOk, setShowOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const { data, error, loading, reload } = useApi(`/reports/alerts${qs(filters, { reviewed: showOk ? '1' : '' })}`);

  const review = async (keys, status) => {
    setBusy(true);
    setSaveError(null);
    try {
      await api('/alerts/review', { method: 'POST', body: { keys, status } });
      setConfirmAll(false);
      reload();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <><ErrorBox error={error} />{!error && <Empty>Loading…</Empty>}</>;
  const items = data.items.filter((i) => (!type || i.type === type) && (!severity || i.severity === severity));
  const open = items.filter((i) => i.review?.status !== 'ok');

  return (
    <Loading loading={loading}>
      <PageHeader title="Alerts" subtitle="Figures in your files that look wrong, checked against your own usual numbers.">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
            <option value="">All severities</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="info">Info</option>
          </Select>
          <Select value={type} onChange={(e) => setType(e.target.value)} aria-label="Alert type">
            <option value="">All alerts</option>
            {data.byType.map((t) => <option key={t.type} value={t.type}>{t.label} ({t.count})</option>)}
          </Select>
          <label className="flex items-center gap-1.5 text-sm text-ink-2">
            <input type="checkbox" checked={showOk} onChange={(e) => setShowOk(e.target.checked)} /> Show marked OK
          </label>
        </div>
      </PageHeader>
      <ErrorBox error={error || saveError} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="High" value={n(data.counts.high)} sub="money lost or files that disagree" tone={data.counts.high ? 'bad' : undefined} />
        <Stat label="Medium" value={n(data.counts.medium)} sub="worth a look" />
        <Stat label="Info" value={n(data.counts.info)} sub="unusual, maybe fine" />
        <Stat label="Overdue payments" value={n(data.gaps.overduePayments.lines)} sub={`${rs(data.gaps.overduePayments.paise)} expected`} />
        <Stat label={`Returns open ${data.gaps.staleReturns.days}+ days`} value={n(data.gaps.staleReturns.count)} sub={<Link to="/health" className="underline">see Data health</Link>} />
      </div>

      <Card
        className="mt-4"
        title={`${n(items.length)} alert${items.length === 1 ? '' : 's'}${data.reviewedOk && !showOk ? ` · ${n(data.reviewedOk)} marked OK hidden` : ''}`}
        action={open.length > 0 && (
          confirmAll ? (
            <span className="flex items-center gap-2 text-xs text-ink-2">
              Mark all {n(open.length)} shown as OK?
              <Button variant="primary" disabled={busy} onClick={() => review(open.map((i) => i.key), 'ok')}>Yes</Button>
              <Button variant="ghost" onClick={() => setConfirmAll(false)}>No</Button>
            </span>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmAll(true)}>Mark all shown OK</Button>
          )
        )}
      >
        {!items.length ? (
          <Empty>Nothing odd in your files{type || severity ? ' for this filter' : ''}.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr><th>Severity</th><th>What</th><th>Details</th><th className="r">Amount</th><th>Date</th><th>Platform</th><th>Order</th><th /></tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.key} className={i.review?.status === 'ok' ? 'opacity-60' : ''}>
                    <td className="whitespace-nowrap">
                      <Status kind={SEVERITY[i.severity].kind}>{SEVERITY[i.severity].label}</Status>
                      {i.review?.status === 'follow_up' && <div className="text-[11px] text-ink-2">following up</div>}
                    </td>
                    <td className="min-w-[14rem]">
                      <div className="font-medium text-ink">{i.title}</div>
                      <div className="text-xs text-muted">{i.label}</div>
                    </td>
                    <td className="min-w-[16rem] text-ink-2">
                      {i.detail}
                      <div className="mt-0.5 text-xs text-muted">{i.hint}</div>
                    </td>
                    <td className={`r ${i.amountPaise < 0 ? 'text-bad' : ''}`}>{i.amountPaise != null ? rs(i.amountPaise) : '—'}</td>
                    <td className="whitespace-nowrap">{i.date ? niceDate(i.date) : '—'}</td>
                    <td>{i.platform ? <PlatformTag platform={i.platform} /> : '—'}</td>
                    <td>
                      {i.orderId ? <div className="font-mono text-xs">{i.orderId}</div> : '—'}
                      {(i.product || i.sku) && <div className="text-xs text-muted">{i.product || i.sku}</div>}
                    </td>
                    <td className="whitespace-nowrap">
                      {i.review?.status === 'ok' ? (
                        <Button variant="ghost" disabled={busy} onClick={() => review([i.key], '')}>Undo</Button>
                      ) : (
                        <span className="flex gap-1">
                          <Button disabled={busy} onClick={() => review([i.key], 'ok')} title="Checked, nothing to do — hide it">OK</Button>
                          {i.review?.status === 'follow_up'
                            ? <Button variant="ghost" disabled={busy} onClick={() => review([i.key], '')}>Unpin</Button>
                            : <Button variant="ghost" disabled={busy} onClick={() => review([i.key], 'follow_up')} title="Keep it at the top">Follow up</Button>}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Loading>
  );
}
