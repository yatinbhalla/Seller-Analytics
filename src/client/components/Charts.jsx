import { useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { niceDate, PLATFORMS, rs, rsShort } from '../lib/format.js';

const axisProps = {
  stroke: 'var(--axis)',
  tick: { fill: 'var(--muted)', fontSize: 11 },
  tickLine: false,
};

/** Tooltip: values lead (strong), series name follows; series keyed by a short line, not a box. */
function TrendTooltip({ active, payload, label, valueKey }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-line bg-raised px-3 py-2 text-xs shadow-sm">
      <div className="mb-1 text-muted">{niceDate(label)}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-3" style={{ background: p.color }} />
          <span className="font-semibold text-ink">{rs(p.value)}</span>
          <span className="text-ink-2">{p.name}</span>
        </div>
      ))}
      {valueKey && null}
    </div>
  );
}

/**
 * Daily sales (or profit) per platform. One y-axis, one measure — profit and sales
 * are two separate charts, never a dual axis.
 */
export function TrendChart({ rows, measure = 'gmv', platforms, empty = 'No orders in this range.' }) {
  const shown = PLATFORMS.filter((p) => rows.some((r) => r[`${p.key}_${measure}`] != null) && (!platforms?.length || platforms.includes(p.key)));
  if (!rows.length) return <div className="py-10 text-center text-sm text-ink-2">{empty}</div>;
  return (
    <div>
      <Legend items={shown.map((p) => ({ label: p.label, color: p.color, kind: 'line' }))} />
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 16, left: 4, bottom: 0 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="day" {...axisProps} tickFormatter={niceDate} minTickGap={24} />
            <YAxis {...axisProps} axisLine={false} tickFormatter={rsShort} width={56} />
            <ReferenceLine y={0} stroke="var(--axis)" />
            <Tooltip content={<TrendTooltip />} cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }} />
            {shown.map((p) => (
              <Line
                key={p.key}
                type="monotone"
                dataKey={`${p.key}_${measure}`}
                name={p.label}
                stroke={p.color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function Legend({ items }) {
  if (items.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-4 text-xs text-ink-2">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          {i.kind === 'line' ? (
            <span className="inline-block h-0.5 w-4" style={{ background: i.color }} />
          ) : (
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: i.color }} />
          )}
          {i.label}
        </span>
      ))}
    </div>
  );
}

/**
 * The P&L waterfall: each step floats from the running total; subtotals drop to the
 * baseline. Gains and costs are told apart by direction and by the signed label, not
 * by colour alone.
 */
export function Waterfall({ steps }) {
  let running = 0;
  const data = steps.map((s) => {
    if (s.subtotal) {
      running = s.value;
      return { label: s.label, base: Math.min(0, s.value), size: Math.abs(s.value), value: s.value, subtotal: true };
    }
    const start = running;
    running += s.value;
    return { label: s.label, base: Math.min(start, running), size: Math.abs(s.value), value: s.value };
  });
  const [hover, setHover] = useState(null);
  return (
    <div>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }} barCategoryGap={4} onMouseLeave={() => setHover(null)}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="label" {...axisProps} tick={false} height={4} />
            <YAxis {...axisProps} axisLine={false} tickFormatter={rsShort} width={56} />
            <ReferenceLine y={0} stroke="var(--axis)" />
            <Tooltip
              cursor={{ fill: 'var(--wash)' }}
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <div className="rounded-md border border-line bg-raised px-3 py-2 text-xs shadow-sm">
                    <div className="font-semibold text-ink">{rs(payload[0].payload.value)}</div>
                    <div className="text-ink-2">{payload[0].payload.label}</div>
                  </div>
                ) : null
              }
            />
            <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
            <Bar dataKey="size" stackId="w" radius={[3, 3, 0, 0]} isAnimationActive={false} onMouseEnter={(_, i) => setHover(i)}>
              {data.map((d, i) => (
                <Cell
                  key={d.label}
                  fill={d.subtotal ? 'var(--ink-2)' : d.value >= 0 ? 'var(--good)' : 'var(--bad)'}
                  fillOpacity={hover == null || hover === i ? 1 : 0.6}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="data mt-3">
        <tbody>
          {data.map((d) => (
            <tr key={d.label} className={d.subtotal ? 'font-semibold' : ''}>
              <td>{d.label}</td>
              <td className={`r ${d.subtotal ? '' : d.value > 0 ? 'text-green-700 dark:text-green-400' : d.value < 0 ? 'text-red-600 dark:text-red-400' : ''}`}>
                {d.subtotal ? rs(d.value) : `${d.value >= 0 ? '+' : '−'} ${rs(Math.abs(d.value))}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Horizontal bars for a ranked list (return reasons). Single series — no legend box. */
export function RankBars({ rows, label = (r) => r.label, value = (r) => r.value, format = (v) => v }) {
  const max = Math.max(1, ...rows.map(value));
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={label(r)} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 text-sm">
          <div className="min-w-0">
            <div className="truncate text-ink" title={label(r)}>
              {label(r)}
            </div>
            <div className="mt-0.5 h-2 rounded-r-sm bg-wash">
              <div className="h-2 rounded-r-sm" style={{ width: `${(value(r) / max) * 100}%`, background: 'var(--series)' }} />
            </div>
          </div>
          <div className="num text-ink-2">{format(value(r))}</div>
        </li>
      ))}
    </ul>
  );
}
