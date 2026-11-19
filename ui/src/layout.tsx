// Shell plumbing: state kept across reloads, media queries, and the drag handle that resizes the side panels.
import { useCallback, useEffect, useRef, useState } from 'react';

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

/** useState that survives a reload. Values are JSON. */
export function useStored<T>(key: string, init: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    const raw = read(key);
    if (raw == null) return init;
    try { return JSON.parse(raw) as T; } catch { return init; }
  });
  useEffect(() => { write(key, JSON.stringify(v)); }, [key, v]);
  return [v, setV];
}

export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Vertical drag handle on the edge of a side panel. `side` is the edge the handle sits on:
 * a left sidebar has its handle on the right edge and grows when dragged right, a right panel the opposite.
 * Double-click resets to the default width.
 */
export function Resizer({ side, width, min, max, onWidth, onReset, label }: {
  side: 'left' | 'right'; width: number; min: number; max: number; onWidth: (w: number) => void; onReset: () => void; label: string;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const [drag, setDrag] = useState(false);
  const move = useCallback((e: PointerEvent) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    onWidth(clamp(Math.round(start.current.w + (side === 'right' ? dx : -dx)), min, max));
  }, [side, min, max, onWidth]);
  const up = useCallback(() => {
    start.current = null; setDrag(false);
    document.body.classList.remove('resizing');
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
  }, [move]);
  useEffect(() => up, [up]);
  return (
    <div className={`resizer on-${side} ${drag ? 'drag' : ''}`} role="separator" aria-orientation="vertical" aria-label={label}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} tabIndex={0} title={`${label}. Double-click to reset`}
      onPointerDown={e => {
        e.preventDefault();
        // Start from the width on screen, which can be less than the stored one in a small window.
        const shown = e.currentTarget.parentElement?.getBoundingClientRect().width;
        start.current = { x: e.clientX, w: Math.round(shown ?? width) }; setDrag(true);
        document.body.classList.add('resizing');
        addEventListener('pointermove', move); addEventListener('pointerup', up);
      }}
      onDoubleClick={onReset}
      onKeyDown={e => {
        const step = e.shiftKey ? 48 : 16;
        const grow = side === 'right' ? 'ArrowRight' : 'ArrowLeft', shrink = side === 'right' ? 'ArrowLeft' : 'ArrowRight';
        if (e.key === grow) { e.preventDefault(); onWidth(clamp(width + step, min, max)); }
        if (e.key === shrink) { e.preventDefault(); onWidth(clamp(width - step, min, max)); }
      }} />
  );
}
