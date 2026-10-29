import { AlertTriangle, CheckCircle2, Info, Loader2, Sparkles, X, XOctagon } from 'lucide-react';
import { createContext, ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { date as formatDate, dueLabel, initials } from '../lib/format';
import { CLASSIFICATION, PRIORITY, PROCESSING, TASK_STATUS } from '../lib/labels';
import { usePrefs, useT } from '../lib/prefs';

/* ------------------------------------------------------------------ marks */

/** The ministry's mark: the gold five-pointed star of the national flag on navy. */
export function Mark({ size = 36 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect x="1" y="1" width="38" height="38" rx="9" fill="#0d2240" stroke="#c9a227" strokeWidth="1.5" />
      <path d="M20 7.5l3.53 10.86h11.42l-9.24 6.71 3.53 10.86L20 29.22l-9.24 6.71 3.53-10.86-9.24-6.71h11.42z" fill="#e3c35a" />
    </svg>
  );
}

export function Avatar({ name, small }: { name: string; small?: boolean }) {
  return (
    <span className={`avatar${small ? ' sm' : ''}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/* ------------------------------------------------------------------ status */

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'assist';

export function Badge({ tone = 'neutral', children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return <span className={`badge ${tone}${dot ? ' dot-status' : ''}`}>{children}</span>;
}

function fromMap(map: Record<string, [string, string, Tone]>, key: string, lang: string) {
  const v = map[key];
  return v ? { text: lang === 'en' ? v[1] : v[0], tone: v[2] } : { text: key, tone: 'neutral' as Tone };
}

export function ProcessingBadge({ state, closed }: { state: string; closed?: boolean }) {
  const { language, t } = usePrefs();
  if (closed) return <Badge tone="neutral">{t('Gesloten', 'Closed')}</Badge>;
  const v = fromMap(PROCESSING, state, language);
  return <Badge tone={v.tone}>{v.text}</Badge>;
}

export function TaskStatusBadge({ status }: { status: string }) {
  const { language } = usePrefs();
  const v = fromMap(TASK_STATUS, status, language);
  return <Badge tone={v.tone}>{v.text}</Badge>;
}

export function PriorityBadge({ priority, quiet }: { priority: string; quiet?: boolean }) {
  const { language } = usePrefs();
  if (quiet && (priority === 'MEDIUM' || priority === 'LOW')) return null;
  const v = fromMap(PRIORITY, priority, language);
  return <Badge tone={v.tone}>{v.text}</Badge>;
}

/** A registration or matter number, shown as the post room stamps it. */
export function Stamp({ value, to, draft }: { value: string | null; to?: string; draft?: boolean }) {
  const t = useT();
  const text = value ?? t('Concept', 'Draft');
  const cls = `stamp${draft || !value ? ' draft' : ''}`;
  return to ? (
    <Link className={cls} to={to}>
      {text}
    </Link>
  ) : (
    <span className={cls}>{text}</span>
  );
}

export function ClassStamp({ level, always }: { level: string; always?: boolean }) {
  const { language } = usePrefs();
  if (!always && (level === 'INTERNAL' || level === 'OPEN')) return null;
  const v = CLASSIFICATION[level];
  return <span className={`stamp class-${level}`}>{v ? (language === 'en' ? v[1] : v[0]) : level}</span>;
}

export function Due({ date, done }: { date: string | null | undefined; done?: boolean }) {
  const { language } = usePrefs();
  // Finished work is not late any more: it shows the deadline it had, as a plain date.
  if (done) return <span className="due">{date ? (language === 'en' ? `due ${formatDate(date, language)}` : `termijn ${formatDate(date, language)}`) : '—'}</span>;
  const d = dueLabel(date, language);
  return <span className={`due ${d.tone}`}>{d.text}</span>;
}

export function Confidence({ value }: { value: number }) {
  const t = useT();
  return (
    <span className="confidence-wrap">
      <span className="xs muted">{t(`${Math.round(value * 100)}% zeker`, `${Math.round(value * 100)}% sure`)}</span>
      <span className="confidence" aria-hidden="true">
        <span style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ layout */

export function PageHead({ title, lead, actions, crumbs }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode; crumbs?: { to: string; label: string }[] }) {
  return (
    <header className="page-head">
      <div className="grow">
        {crumbs && (
          <nav className="crumbs" aria-label="Kruimelpad">
            {crumbs.map((c, i) => (
              <span key={c.to} className="row" style={{ gap: 6 }}>
                {i > 0 && <span aria-hidden="true">/</span>}
                <Link to={c.to}>{c.label}</Link>
              </span>
            ))}
          </nav>
        )}
        <h1>{title}</h1>
        {lead && <p className="lead">{lead}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}

export function Panel({ title, actions, children, flush, className, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string; id?: string }) {
  return (
    <section className={`panel ${className ?? ''}`} id={id} aria-label={typeof title === 'string' ? title : undefined}>
      {(title || actions) && (
        <div className="panel-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Figure({ value, label, to, tone }: { value: ReactNode; label: string; to?: string; tone?: 'alert' | 'warn' | 'good' }) {
  const inner = (
    <>
      <span className="value">{value}</span>
      <span className="label">{label}</span>
    </>
  );
  return to ? (
    <Link className={`figure ${tone ?? ''}`} to={to}>
      {inner}
    </Link>
  ) : (
    <div className={`figure ${tone ?? ''}`}>{inner}</div>
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ feedback */

export function Loading({ lines = 3 }: { lines?: number }) {
  const t = useT();
  return (
    <div className="stack" aria-busy="true" aria-label={t('Bezig met laden', 'Loading')} style={{ padding: '6px 0' }}>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - i * 14}%` }} />
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" style={{ gap: 6 }} role="status">
      <Loader2 size={16} className="spin" style={{ animation: 'spin 1s linear infinite' }} aria-hidden="true" />
      {label && <span className="muted small">{label}</span>}
    </span>
  );
}

export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; title?: ReactNode; children?: ReactNode }) {
  const Icon = tone === 'danger' ? XOctagon : tone === 'warn' ? AlertTriangle : tone === 'ok' ? CheckCircle2 : Info;
  return (
    <div className={`notice ${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon size={20} aria-hidden="true" />
      <div className="stack" style={{ gap: 4 }}>
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <Notice tone="danger">{error}</Notice>;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

/** The label every suggestion of the assistant carries. */
export function Proposal({ title, children, actions, engine }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; engine?: EngineInfo | null }) {
  const t = useT();
  return (
    <div className="proposal">
      <div className="proposal-head">
        <span className="proposal-title">
          <Sparkles size={16} aria-hidden="true" />
          <span>{title ?? t('Voorstel van de assistent', 'Suggestion from the assistant')}</span>
        </span>
        {actions && <span className="proposal-actions">{actions}</span>}
      </div>
      <div className="proposal-body stack">
        {children}
        {engine && <EngineNote engine={engine} />}
      </div>
    </div>
  );
}

export interface EngineInfo {
  provider: string;
  model: string;
  local: boolean;
  fallback?: string;
}

export function EngineNote({ engine }: { engine: EngineInfo }) {
  const t = useT();
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className="engine-note">
        {engine.provider === 'builtin'
          ? t('Ingebouwde assistent, op de eigen server. Er gaat niets naar buiten.', 'Built-in assistant, on the ministry’s own server. Nothing leaves it.')
          : `${engine.model} — ${engine.local ? t('op het eigen netwerk', 'on the ministry network') : t('externe dienst', 'external service')}`}
      </span>
      {engine.fallback && <span className="engine-note">{engine.fallback}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ inputs */

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <div className={`field ${className ?? ''}`}>
      <label>
        <span className="label" style={{ display: 'block', marginBottom: 5, fontWeight: 600, fontSize: 'var(--text-sm)' }}>
          {label}
        </span>
        {children}
      </label>
      {hint && <span className="hint">{hint}</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

export function Segmented<V extends string>({ value, options, onChange, label }: { value: V; options: { value: V; label: ReactNode }[]; onChange: (v: V) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<V extends string>({ value, tabs, onChange, label }: { value: V; tabs: { value: V; label: ReactNode; count?: number; hidden?: boolean }[]; onChange: (v: V) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button key={t.value} type="button" role="tab" aria-selected={t.value === value} onClick={() => onChange(t.value)}>
            {t.label}
            {t.count !== undefined && t.count > 0 && <span className="count">{t.count}</span>}
          </button>
        ))}
    </div>
  );
}

/* ------------------------------------------------------------------ dialogs */

export function Dialog({ title, children, footer, onClose, wide }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close])');
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus?.();
    };
  }, [onClose]);
  // Drawn at the top of the page, so the menu and the top bar are dimmed with the rest.
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <div className="dialog-head">
          <h2 id={id}>{title}</h2>
          <button type="button" className="icon-btn" data-close onClick={onClose} aria-label={t('Sluiten', 'Close')}>
            <X size={20} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Confirm({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
  danger,
  busy,
  error,
  disabled,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="button" className={`btn ${danger ? 'danger solid' : 'primary'}`} onClick={onConfirm} disabled={busy || disabled}>
            {busy ? t('Bezig…', 'Working…') : confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack">
        {children}
        <ErrorNote error={error} />
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ toasts */

const ToastContext = createContext<(text: string, tone?: 'ok' | 'error') => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; text: string; tone: 'ok' | 'error' }[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, tone }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'error' ? 'error' : ''}`}>
            {t.tone === 'error' ? <XOctagon size={18} /> : <CheckCircle2 size={18} />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/* ------------------------------------------------------------------ menus */

export function useOutside(ref: React.RefObject<HTMLElement>, onOutside: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onOutside();
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', key);
    };
  }, [ref, onOutside, active]);
}
