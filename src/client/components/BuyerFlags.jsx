import { Status } from './ui.jsx';

/** A buyer's flags, worst first. Always a word with the icon — never colour alone. */
export default function BuyerFlags({ flags, compact = false }) {
  if (!flags) return null;
  const list = [
    flags.frequentReturner && { kind: 'bad', label: 'Frequent returner' },
    flags.rtoRisk && { kind: 'warn', label: 'RTO risk' },
    flags.good && { kind: 'good', label: 'Good customer' },
    flags.repeat && !flags.good && !flags.frequentReturner && { kind: 'info', label: 'Repeat buyer' },
  ].filter(Boolean);
  if (!list.length) return compact ? null : <span className="text-xs text-muted">—</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {list.map((f) => <Status key={f.label} kind={f.kind}>{f.label}</Status>)}
    </span>
  );
}
