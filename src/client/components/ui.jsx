import { NavLink } from 'react-router';
import { platformColor, platformLabel, rs } from '../lib/format.js';

/**
 * Colour families. Each pairs a tinted background with text that reads on it, in light
 * and dark mode. Colour always comes with a word or number, never on its own.
 */
export const TONES = {
  green: 'bg-green-100 text-green-950 dark:bg-green-950 dark:text-green-100',
  teal: 'bg-teal-100 text-teal-950 dark:bg-teal-950 dark:text-teal-100',
  amber: 'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100',
  red: 'bg-red-100 text-red-950 dark:bg-red-950 dark:text-red-100',
  blue: 'bg-sky-100 text-sky-950 dark:bg-sky-950 dark:text-sky-100',
  violet: 'bg-violet-100 text-violet-950 dark:bg-violet-950 dark:text-violet-100',
  indigo: 'bg-indigo-100 text-indigo-950 dark:bg-indigo-950 dark:text-indigo-100',
  coral: 'bg-orange-100 text-orange-950 dark:bg-orange-950 dark:text-orange-100',
  pink: 'bg-pink-100 text-pink-950 dark:bg-pink-950 dark:text-pink-100',
  gray: 'bg-stone-100 text-stone-900 dark:bg-stone-800 dark:text-stone-100',
};
/** The softer text for labels and notes inside a tinted tile. */
const TONE_SOFT = {
  green: 'text-green-800 dark:text-green-300', teal: 'text-teal-800 dark:text-teal-300', amber: 'text-amber-800 dark:text-amber-300',
  red: 'text-red-800 dark:text-red-300', blue: 'text-sky-800 dark:text-sky-300', violet: 'text-violet-800 dark:text-violet-300',
  indigo: 'text-indigo-800 dark:text-indigo-300', coral: 'text-orange-800 dark:text-orange-300', pink: 'text-pink-800 dark:text-pink-300',
  gray: 'text-stone-600 dark:text-stone-300',
};
/** A coloured bar along the top of a card or table section. */
const TONE_BAR = {
  green: 'border-t-green-500', teal: 'border-t-teal-500', amber: 'border-t-amber-500', red: 'border-t-red-500', blue: 'border-t-sky-500',
  violet: 'border-t-violet-500', indigo: 'border-t-indigo-500', coral: 'border-t-orange-500', pink: 'border-t-pink-500', gray: 'border-t-stone-400',
};

/** Priorities, everywhere they show: alerts, Data Health, Needs attention. */
export const PRIORITY = {
  high: { tone: 'red', label: 'High' },
  medium: { tone: 'amber', label: 'Medium' },
  info: { tone: 'blue', label: 'Info' },
  good: { tone: 'green', label: 'Good' },
};

/** Payment types, as chips. */
export const KIND_TONE = {
  sale: 'green', return: 'coral', rto: 'amber', cancelled: 'gray', penalty: 'red', claim: 'blue', ads: 'violet', tax: 'gray', other: 'gray',
};

export function Card({ title, action, children, className = '', tone }) {
  return (
    <section className={`rounded-xl border border-line bg-surface ${tone ? `border-t-4 ${TONE_BAR[tone]}` : ''} ${className}`}>
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

/** A headline figure on a tinted background. */
export function Tile({ tone = 'gray', label, value, sub }) {
  return (
    <div className={`rounded-xl px-4 py-3 ${TONES[tone]}`}>
      <div className={`text-xs font-medium ${TONE_SOFT[tone]}`}>{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums sm:text-2xl">{value}</div>
      {sub && <div className={`mt-0.5 text-xs ${TONE_SOFT[tone]}`}>{sub}</div>}
    </div>
  );
}

export function Chip({ tone = 'gray', children, title }) {
  return (
    <span title={title} className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function PriorityBadge({ level }) {
  const p = PRIORITY[level] || PRIORITY.info;
  return <Chip tone={p.tone}>{p.label}</Chip>;
}

/** Money in green, money out in red; zero and unknown stay plain. */
export function Money({ paise, className = '' }) {
  const tone = paise == null || paise === 0 ? 'text-ink' : paise > 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400';
  return <span className={`whitespace-nowrap tabular-nums ${tone} ${className}`}>{rs(paise)}</span>;
}

/** The tabs of an area (Payments, Orders, Data), underlined in the area's colour. */
export function Tabs({ items, bar }) {
  return (
    <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-line" aria-label="Section">
      {items.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            `-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ${isActive ? `${bar} font-medium text-ink` : 'border-transparent text-ink-2 hover:text-ink'}`
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
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

/**
 * A single headline figure on a plain card. `tone` 'bad' / 'good' colours the value;
 * `color` gives the card a coloured top bar (a TONES name).
 */
export function Stat({ label, value, sub, tone, color }) {
  const toneClass = tone === 'bad' ? 'text-red-600 dark:text-red-400' : tone === 'good' ? 'text-green-700 dark:text-green-400' : 'text-ink';
  return (
    <div className={`rounded-xl border border-line bg-surface px-4 py-3 ${color ? `border-t-4 ${TONE_BAR[color]}` : ''}`}>
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
    good: { icon: '✓', tone: 'green' },
    warn: { icon: '!', tone: 'amber' },
    bad: { icon: '✕', tone: 'red' },
    info: { icon: 'i', tone: 'blue' },
  };
  const s = map[kind] || map.info;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 text-xs font-medium ${TONES[s.tone]}`}>
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-white/70 text-[10px] font-bold dark:bg-black/30">
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

export function Notice({ children, tone = 'amber' }) {
  return <div className={`mb-4 rounded-xl px-4 py-2.5 text-sm ${TONES[tone]}`}>{children}</div>;
}
