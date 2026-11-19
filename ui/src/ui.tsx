import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { QuotaWindow } from './types.ts';
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
