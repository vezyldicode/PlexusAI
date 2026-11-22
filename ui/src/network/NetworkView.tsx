import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Maximize2, Minus, Plus } from 'lucide-react';
import { api, timeAgo } from '../api.ts';
import type { LogLine, ProjectDetail } from '../store.ts';
import type { Account, Provider, Role, Task } from '../types.ts';
import { Dot, Ic, label, Tokens } from '../ui.tsx';
import { COORD_H, COORD_W, COORDINATOR, layout, NODE_H, NODE_W, originOf, type NodeBox } from './layout.ts';
import { EffortSelect, ModelDatalist, shownModel, useModels } from '../models.tsx';
import { modelLabel } from '../settings.tsx';

interface Props {
  detail: ProjectDetail;
  accounts: Account[];
  lastLine: Record<string, LogLine>;
  thinking: string | null;
  active: string;
  onOpen: (id: string) => void;
  onError: (e: string) => void;
  reload: () => void;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function NetworkView({ detail, accounts, lastLine, thinking, active, onOpen, onError, reload }: Props) {
  const [showFinished, setShowFinished] = useState(() => localStorage.getItem('plexus.net.finished') !== '0');
  const g = useMemo(() => layout(detail.tasks, showFinished), [detail.tasks, showFinished]);
  const [roles, setRoles] = useState<Role[]>([]);
  useEffect(() => { api<Role[]>('GET', '/api/roles').then(setRoles).catch(() => {}); }, []);
  const roleOf = (t: Task) => roles.find(r => r.name === t.role);
  const accountOf = (t: Task) => accounts.find(a => a.id === (t.accountId ?? t.lastAccountId));
  // Not started yet: the role's first preferred provider that has a usable account, else any enabled account's provider.
  const providerOf = (t: Task): Provider => {
    const a = accountOf(t);
    if (a) return a.provider;
    const usable = new Set(accounts.filter(x => x.enabled).map(x => x.provider));
    return roleOf(t)?.providers.find(p => usable.has(p)) ?? accounts.find(x => x.enabled)?.provider ?? roleOf(t)?.providers[0] ?? 'claude';
  };
  const catalog = useModels();
  // What the daemon says the task runs with (its override, the coordinator's for single-agent work, the role's, or what the CLI reported).
  const modelOf = (t: Task) => { const info = detail.models?.[t.id]; const m = shownModel(info).model; return m ? modelLabel(catalog, info!.provider, m) : ''; };
  const effortOf = (t: Task) => shownModel(detail.models?.[t.id]).effort ?? '';

  // ---- pan & zoom
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 24, y: 24, k: 1 });
  const fitted = useRef<string | null>(null);
  const fit = () => {
    const el = box.current;
    if (!el) return;
    const pad = 48;
    const w = g.width + pad * 2, h = g.height + pad * 2;
    // Fit when the graph is small enough to stay readable; otherwise keep 60 % and anchor to the top left.
    const k = Math.min(1, Math.max(0.8, Math.min(el.clientWidth / w, el.clientHeight / h)));
    const fitsX = g.width * k + pad * 2 <= el.clientWidth, fitsY = g.height * k + pad * 2 <= el.clientHeight;
    setView({ k, x: fitsX ? (el.clientWidth - g.width * k) / 2 : pad, y: fitsY ? (el.clientHeight - g.height * k) / 2 : pad });
  };
  useEffect(() => {
    // Fit once per project, and again whenever the graph outgrows the screen at the current zoom.
    const key = detail.project.id;
    if (fitted.current !== key) { fitted.current = key; fit(); }
  }, [detail.project.id, g.width, g.height]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      setView(v => {
        const k = Math.min(1.6, Math.max(0.3, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const zoomBy = (f: number) => {
    const el = box.current!;
    const cx = el.clientWidth / 2, cy = el.clientHeight / 2;
    setView(v => { const k = Math.min(1.6, Math.max(0.3, v.k * f)); return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k }; });
  };

  // ---- hover card & model popover
  const [hover, setHover] = useState<NodeBox | null>(null);
  const [edit, setEdit] = useState<{ n: NodeBox; provider: Provider; model: string; effort: string } | null>(null);
  const editFor = (n: NodeBox, provider: Provider) => ({ n, provider, model: n.task.models?.[provider] ?? '', effort: n.task.efforts?.[provider] ?? '' });
  const saveModel = () => {
    if (!edit) return;
    const t = edit.n.task;
    const models = { ...t.models, [edit.provider]: edit.model.trim() || undefined };
    const efforts = { ...t.efforts, [edit.provider]: edit.effort || undefined };
    api('PATCH', `/api/tasks/${t.id}`, { models, efforts }).then(() => { setEdit(null); reload(); }).catch(e => onError(e.message));
  };
  const screen = (x: number, y: number) => ({ left: view.x + x * view.k, top: view.y + y * view.k });

  const animate = !reducedMotion();
  const running = detail.tasks.filter(t => t.status === 'running').length;
  const coordState = thinking ? 'running' : detail.project.status === 'running' ? 'ok' : 'idle';

  return (
    <div className="net" ref={box}
      onPointerDown={e => {
        if ((e.target as HTMLElement).closest('.node, .net-tools, .popover')) return;
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setEdit(null);
      }}
      onPointerMove={e => { const d = drag.current; if (d) setView(v => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y })); }}
      onPointerUp={() => { drag.current = null; }}>

      <div className="net-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="net-edges" width={g.width + 64} height={g.height + 64} aria-hidden>
          {g.lanes.map(l => <rect key={l.id} className={`lane-bg ${l.running ? 'live' : ''}`} x={l.x - 12} y={l.y - 4} width={l.w + 24} height={l.h + 16} rx={14} />)}
          {g.edges.map(e => (
            <g key={e.id} className={`edge e-${e.kind} ${e.live ? 'live' : ''} ${active === e.to || active === e.from ? 'sel' : ''}`}>
              <path d={e.d} />
              {e.live && animate && (
                <circle r={3} className="signal">
                  <animateMotion dur="1.8s" repeatCount="indefinite" path={e.d} keyPoints="0;1" keyTimes="0;1" calcMode="linear" />
                </circle>
              )}
            </g>
          ))}
        </svg>

        {g.lanes.map(l => (
          <div key={l.id} className="lane-title" style={{ left: l.x, top: l.y, maxWidth: Math.max(l.w, NODE_W) }}>
            <span className="lane-name">{l.title}</span>
            <span className="lane-meta num">{l.done}/{l.total}</span>
          </div>
        ))}

        <button className={`node coord ${active === COORDINATOR ? 'sel' : ''} s-${coordState}`} style={{ left: g.coord.x, top: g.coord.y, width: COORD_W, height: COORD_H }}
          onClick={() => onOpen(COORDINATOR)}>
          <div className="node-top"><Dot state={coordState} /><span className="node-id">Coordinator</span><span className="node-role">main agent</span></div>
          <div className="node-title">{thinking ? `Thinking on ${thinking}` : `${running} agent${running === 1 ? '' : 's'} running`}</div>
          <div className="node-meta">{label(detail.project.status)} · {detail.project.phase}</div>
        </button>

        {g.nodes.map(n => {
          const t = n.task;
          const acct = accountOf(t);
          const model = modelOf(t);
          const from = originOf(t);
          return (
            <div key={n.id} role="button" tabIndex={0} className={`node s-${t.status} o-${from} ${active === t.id ? 'sel' : ''}`} style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
              onClick={() => onOpen(t.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t.id); } }}
              onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(h => (h?.id === n.id ? null : h))}>
              <div className="node-top">
                <Dot state={t.status} />
                <span className="node-id num">T{t.seq}</span>
                <span className="node-role">{from === 'coordinator' ? 'coordinator edit' : t.role}</span>
                {from === 'chat' && <span className="tag" title="Asked for in the coordinator chat">chat</span>}
                <Tokens u={detail.usage.tasks[t.id]} className="node-tok" />
                {t.attempts > 1 && <span className="node-att num" title="Attempts">×{t.attempts}</span>}
              </div>
              <div className="node-title">{t.title}</div>
              {from === 'coordinator' ? (
                <div className="node-meta"><span className="node-acct mono">{t.paths.length === 1 ? t.paths[0] : `${t.paths.length} files`}</span><span className="node-acct">{timeAgo(t.updatedAt)}</span></div>
              ) : <div className="node-meta">
                <span className="node-acct">{acct?.label ?? (t.status === 'pending' ? 'queued' : '—')}</span>
                <button className="chip" title="Model and effort for this task (applies from the next attempt)"
                  onClick={e => { e.stopPropagation(); setHover(null); setEdit(editFor(n, providerOf(t))); }}>
                  {model || 'default'}{effortOf(t) ? ` · ${effortOf(t)}` : ''}
                </button>
              </div>}
            </div>
          );
        })}
      </div>

      {!detail.tasks.length && <div className="net-hint">Agents appear here once Plexus starts</div>}

      {hover && !edit && (() => {
        const t = hover.task;
        const line = lastLine[t.id];
        const pos = screen(hover.x + NODE_W + 12, hover.y);
        return (
          <div className="hovercard" style={pos}>
            <div className="hc-title">T{t.seq} {t.title}</div>
            <dl className="hc-grid">
              <dt>Status</dt><dd>{label(t.status)}</dd>
              {originOf(t) === 'coordinator' ? <><dt>By</dt><dd>The coordinator, itself</dd></> : <>
                <dt>Role</dt><dd>{t.role} · {t.kind}</dd>
                <dt>Account</dt><dd>{accountOf(t)?.label ?? '—'}</dd>
                <dt>Model</dt><dd>{modelOf(t) || 'CLI default'}{effortOf(t) ? ` · ${effortOf(t)} effort` : ''}</dd>
              </>}
              {originOf(t) !== 'plan' && <><dt>From</dt><dd>{t.originSessionId ? 'Coordinator chat' : 'Coordinator'}</dd></>}
              {t.branch && <><dt>Branch</dt><dd className="mono">{t.branch}</dd></>}
              {t.paths.length > 0 && <><dt>Files</dt><dd className="mono">{t.paths.join(', ')}</dd></>}
              <dt>Updated</dt><dd>{timeAgo(t.updatedAt)}</dd>
            </dl>
            {line && t.status === 'running' && <div className="hc-line mono">{line.text.slice(0, 220)}</div>}
            {t.error && t.status !== 'done' && <div className="hc-line err">{t.error.slice(0, 220)}</div>}
            {originOf(t) === 'coordinator' && t.result?.summary && <div className="hc-line">{t.result.summary}</div>}
            <div className="hc-foot">{originOf(t) === 'coordinator' ? 'Click to see the message and files' : "Click to open this agent's input and output"}</div>
          </div>
        );
      })()}

      {edit && (
        <div className="popover" style={screen(edit.n.x, edit.n.y + NODE_H + 8)} onKeyDown={e => { if (e.key === 'Escape') setEdit(null); if (e.key === 'Enter') saveModel(); }}>
          <div className="pop-title">Model and effort for T{edit.n.task.seq}</div>
          <div className="pop-row">
            <select value={edit.provider} onChange={e => setEdit(editFor(edit.n, e.target.value as Provider))}>
              <option value="claude">Claude</option><option value="codex">Codex</option><option value="mock">Mock</option>
            </select>
            <input autoFocus list="model-hints" value={edit.model} placeholder={roleOf(edit.n.task)?.models[edit.provider] || 'CLI default'} onChange={e => setEdit({ ...edit, model: e.target.value })} />
            <ModelDatalist id="model-hints" provider={edit.provider} catalog={catalog} />
          </div>
          <div className="pop-row">
            <EffortSelect catalog={catalog} provider={edit.provider} model={edit.model.trim() || roleOf(edit.n.task)?.models[edit.provider]} value={edit.effort}
              fallbackLabel={roleOf(edit.n.task)?.efforts?.[edit.provider] ? `Effort: ${roleOf(edit.n.task)!.efforts[edit.provider]} (role)` : undefined}
              onChange={v => setEdit({ ...edit, effort: v })} />
          </div>
          <div className="pop-note">{edit.n.task.status === 'running' ? 'Applies from the next attempt' : 'Empty uses the role default'}</div>
          <div className="pop-actions"><button onClick={() => setEdit(null)}>Cancel</button><button className="primary" onClick={saveModel}>Save</button></div>
        </div>
      )}

      <div className="net-tools">
        {g.hiddenLanes > 0 && !showFinished && <span className="tool-note num">{g.hiddenLanes} finished hidden</span>}
        <button className="icon-btn" title={showFinished ? 'Hide finished features' : 'Show finished features'}
          onClick={() => { const v = !showFinished; setShowFinished(v); try { localStorage.setItem('plexus.net.finished', v ? '1' : '0'); } catch { /* ignore */ } }}>
          <Ic i={showFinished ? Eye : EyeOff} />
        </button>
        <span className="tool-sep" />
        <button className="icon-btn" title="Zoom out" onClick={() => zoomBy(1 / 1.2)}><Ic i={Minus} /></button>
        <span className="tool-zoom num">{Math.round(view.k * 100)}%</span>
        <button className="icon-btn" title="Zoom in" onClick={() => zoomBy(1.2)}><Ic i={Plus} /></button>
        <button className="icon-btn" title="Fit to screen" onClick={fit}><Ic i={Maximize2} /></button>
      </div>

      <div className="net-legend">
        <span><Dot state="running" /> Running</span><span><Dot state="pending" /> Queued</span><span><Dot state="in_review" /> In review</span>
        <span><Dot state="done" /> Done</span><span><Dot state="blocked" /> Blocked</span><span><Dot state="failed" /> Failed</span>
      </div>
    </div>
  );
}

