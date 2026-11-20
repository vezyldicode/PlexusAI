import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { QuotaWindow, TokenUsage } from './types.ts';
import { clock, timeAgo } from './api.ts';

/** One icon size and stroke across the app. */
export const Ic = ({ i: I, size = 16 }: { i: LucideIcon; size?: number }) => <I size={size} strokeWidth={1.5} aria-hidden />;

/** Task / account state as a small dot. Colour comes from the state class in styles.css. */
export const Dot = ({ state, title }: { state: string; title?: string }) => <span className={`dot d-${state}`} title={title ?? state} />;

export const label = (s: string) => (s[0]?.toUpperCase() ?? '') + s.slice(1).replace(/_/g, ' ');

/** A thin quota meter: label, bar, percent. The bar fill is scaled with transform so it never animates width. */
export function Meter({ w, name }: { w: QuotaWindow | null | undefined; name: string }) {
  const v = w?.usedPercent;
  const tone = v == null ? '' : v >= 90 ? 'hot' : v >= 70 ? 'warm' : '';
  return (
    <div className="meter" title={w?.resetsAt ? `${name} window resets ${clock(w.resetsAt)} (${timeAgo(w.resetsAt)})` : name}>
      <span className="meter-name">{name}</span>
      <span className="meter-track"><span className={`meter-fill ${tone}`} style={{ transform: `scaleX(${Math.min(100, v ?? 0) / 100})` }} /></span>
      <span className="meter-val num">{v == null ? '–' : `${Math.round(v)}%`}</span>
    </div>
  );
}

export interface MenuItem { label: string; icon?: LucideIcon; danger?: boolean; disabled?: boolean; onSelect: () => void }

/** Right-click menu, positioned at the pointer and kept inside the viewport. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: Math.min(x, innerWidth - r.width - 8), y: Math.min(y, innerHeight - r.height - 8) });
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y]);
  useEffect(() => {
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const bs = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = bs.indexOf(document.activeElement as HTMLButtonElement);
        bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length]?.focus();
        e.preventDefault();
      }
    };
    // Attach after the opening right-click has finished bubbling, or that same event would close the menu.
    const t = setTimeout(() => { addEventListener('mousedown', close); addEventListener('contextmenu', close); addEventListener('blur', onClose); });
    addEventListener('keydown', key);
    return () => { clearTimeout(t); removeEventListener('mousedown', close); removeEventListener('contextmenu', close); removeEventListener('keydown', key); removeEventListener('blur', onClose); };
  }, [onClose]);
  return (
    <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y }}>
      {items.map(it => (
        <button key={it.label} role="menuitem" className={it.danger ? 'danger' : ''} disabled={it.disabled} onClick={() => { onClose(); it.onSelect(); }}>
          {it.icon && <Ic i={it.icon} />}<span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}

export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="empty"><div className="empty-title">{title}</div>{children && <div className="empty-body">{children}</div>}</div>
);

// ---------------------------------------------------------------- tokens

/** 15 · 8.4k · 636k · 1.4M */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const [v, unit] = n < 1e6 ? [n / 1e3, 'k'] : [n / 1e6, 'M'];
  return (v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v))) + unit;
}

const usd = (v: number) => (v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`);

/** Tooltip text: the parts of a total, one per line. */
export function usageTitle(u: TokenUsage): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  return [
    `${fmt(u.total)} tokens${u.partial ? ' (at least; a run ended early)' : ''}`,
    `Input ${fmt(u.input)} · cache read ${fmt(u.cacheRead)} · cache write ${fmt(u.cacheWrite)}`,
    `Output ${fmt(u.output)}${u.reasoning ? ` (reasoning ${fmt(u.reasoning)})` : ''}`,
    ...(u.costUsd != null ? [`≈ ${usd(u.costUsd)} at API list price`] : []),
  ].join('\n');
}

/** A total as a compact figure with its parts on hover. */
export const Tokens = ({ u, unit = false, className = '' }: { u: TokenUsage | null | undefined; unit?: boolean; className?: string }) =>
  u ? <span className={`tok num ${className}`} title={usageTitle(u)}>{u.partial ? '≥' : ''}{fmtTokens(u.total)}{unit ? ' tokens' : ''}</span> : null;

const PARTS = [
  { key: 'output', label: 'Output' },
  { key: 'input', label: 'Input' },
  { key: 'cacheWrite', label: 'Cache write' },
  { key: 'cacheRead', label: 'Cache read' },
] as const;

/** Where a total went: one stacked bar (output brightest, cache reads faintest), its legend, and the models. */
export function UsageBreakdown({ u, note }: { u: TokenUsage; note?: string }) {
  const models = Object.entries(u.byModel).sort((a, b) => tot(b[1]) - tot(a[1]));
  return (
    <div className="usage">
      <div className="usage-bar" role="img" aria-label={usageTitle(u)}>
        {PARTS.filter(p => u[p.key] > 0).map(p => <span key={p.key} className={`usage-seg u-${p.key}`} style={{ flexGrow: u[p.key] }} />)}
      </div>
      <div className="usage-legend">
        {PARTS.map(p => <span key={p.key}><span className={`usage-key u-${p.key}`} />{p.label}<span className="num">{fmtTokens(u[p.key])}</span></span>)}
      </div>
      {models.length > 1 && (
        <div className="usage-models">
          {models.map(([m, t]) => (
            <div key={m} className="usage-model"><span className="mono">{m}</span><span className="num">{fmtTokens(tot(t))}</span><span className="num muted">{t.costUsd != null ? usd(t.costUsd) : ''}</span></div>
          ))}
        </div>
      )}
      {(u.costUsd != null || u.partial || note) && (
        <div className="usage-note">
          {[u.costUsd != null ? `≈ ${usd(u.costUsd)} at API list price, not what a subscription is charged` : '', u.partial ? 'At least this much: a run ended before the CLI reported its totals' : '', note ?? ''].filter(Boolean).join('. ')}
        </div>
      )}
    </div>
  );
}

const tot = (t: { input: number; cacheRead: number; cacheWrite: number; output: number }) => t.input + t.cacheRead + t.cacheWrite + t.output;
