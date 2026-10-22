import { platformColor, platformLabel } from '../lib/format.js';

export function Card({ title, action, children, className = '' }) {
  return (
    <section className={`rounded-lg border border-line bg-surface ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

/** A single headline figure. `delta` is optional context underneath, in ink, never in series colour. */
export function Stat({ label, value, sub, tone }) {
  const toneClass = tone === 'bad' ? 'text-bad' : tone === 'good' ? 'text-good-text' : 'text-ink';
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

export function PlatformTag({ platform }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-ink-2">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: platformColor(platform) }} />
      {platformLabel(platform)}
    </span>
  );
}

/** Status always carries an icon and a word — never colour alone. */
export function Status({ kind, children }) {
  const map = {
    good: { icon: '✓', cls: 'text-good-text' },
    warn: { icon: '!', cls: 'text-ink' },
    bad: { icon: '✕', cls: 'text-bad' },
    info: { icon: 'i', cls: 'text-ink-2' },
  };
  const s = map[kind] || map.info;
  const dot = kind === 'warn' ? 'var(--warn)' : kind === 'bad' ? 'var(--bad)' : kind === 'good' ? 'var(--good)' : 'var(--muted)';
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${s.cls}`}>
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: dot }}>
        {s.icon}
      </span>
      {children}
    </span>
  );
}

export function Button({ children, variant = 'default', className = '', ...props }) {
  const v = {
    primary: 'bg-series text-white hover:opacity-90 border-transparent',
    default: 'bg-raised text-ink hover:bg-wash border-line',
    danger: 'bg-raised text-bad hover:bg-wash border-line',
    ghost: 'bg-transparent text-ink-2 hover:bg-wash border-transparent',
  }[variant];
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${v} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Input(props) {
  return <input {...props} className={`rounded-md border border-line bg-raised px-2 py-1.5 text-sm text-ink ${props.className || ''}`} />;
}

export function Select({ children, ...props }) {
  return (
    <select {...props} className={`rounded-md border border-line bg-raised px-2 py-1.5 text-sm text-ink ${props.className || ''}`}>
      {children}
    </select>
  );
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div className="mb-4 rounded-md border border-line bg-surface px-4 py-3">
      <Status kind="bad">{error}</Status>
    </div>
  );
}

export function Empty({ children }) {
  return <div className="py-10 text-center text-sm text-ink-2">{children}</div>;
}

/** Holds the previous render dimmed while a refetch runs. */
export function Loading({ loading, children }) {
  return <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>{children}</div>;
}

export function Notice({ children }) {
  return <div className="mb-4 rounded-md border border-line bg-surface px-4 py-2.5 text-sm text-ink-2">{children}</div>;
}
