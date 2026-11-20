import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Check, ChevronDown, ChevronRight, PanelRightClose, PanelRightOpen, Pencil, Plus, RotateCcw, Square, Trash2, X } from 'lucide-react';
import { api, clock, timeAgo } from '../api.ts';
import type { ProjectDetail, Plexus } from '../store.ts';
import type { Account, ChatMessage, ChatSession, Project, Provider, Role, Task, TokenUsage } from '../types.ts';
import { ContextMenu, Dot, Ic, label, Tokens, UsageBreakdown, fmtTokens } from '../ui.tsx';
import { useStored } from '../layout.tsx';
import { COORDINATOR } from '../network/layout.ts';
import { effortsFor, useModels } from '../models.tsx';
import { ModelEffort, modelLabel } from '../settings.tsx';

interface Props {
  s: Plexus;
  detail: ProjectDetail;
  /** The chat panel is on screen (not hidden): unread marks of the open session are cleared while it is. */
  visible: boolean;
  mode: 'docked' | 'auto' | 'overlay';
  tabs: string[];
  active: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPin: () => void;
  onUnpin: () => void;
  onHide: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  resizer: ReactNode;
}

export function ChatPanel({ s, detail, visible, mode, tabs, active, onActivate, onClose, onPin, onUnpin, onHide, onMouseEnter, onMouseLeave, resizer }: Props) {
  const byId = new Map(detail.tasks.map(t => [t.id, t]));
  const onCoordinator = active === COORDINATOR || !byId.has(active);
  const current = s.sessions.find(x => x.id === s.sessionId);
  // Looking at a session counts as reading it: system/agent notices that arrive meanwhile are acknowledged right away.
  const viewing = visible && onCoordinator;
  useEffect(() => {
    if (viewing && current && current.unread > 0) api('POST', `/api/chat-sessions/${current.id}/read`).then(s.loadSessions).catch(() => {});
  }, [viewing, current?.id, current?.unread]);
  return (
    <aside className={`chat-panel m-${mode} ${visible ? 'shown' : ''}`} aria-hidden={!visible} inert={!visible} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {resizer}
      <Conversations project={detail.project} s={s} tabs={tabs} byId={byId} active={onCoordinator ? COORDINATOR : active} viewing={viewing}
        onActivate={onActivate} onClose={onClose}
        tools={<>
          {mode === 'docked' && <button className="icon-btn" title="Auto-hide chat" aria-label="Auto-hide chat" onClick={onUnpin}><Ic i={PanelRightClose} /></button>}
          {mode === 'auto' && <button className="icon-btn" title="Keep chat open" aria-label="Keep chat open" onClick={onPin}><Ic i={PanelRightOpen} /></button>}
          {mode === 'overlay' && <button className="icon-btn" title="Close chat" aria-label="Close chat" onClick={onHide}><Ic i={X} /></button>}
        </>} />
      {onCoordinator
        ? <CoordinatorChat project={detail.project} accounts={s.accounts} sessionId={s.sessionId} messages={s.messages} thinking={s.sessionId ? s.thinking[s.sessionId] ?? null : null} onError={s.setError} reload={s.loadDetail} />
        : <AgentChat key={active} task={byId.get(active)!} accounts={s.accounts} logTick={s.logTick} onError={s.setError} reload={s.loadDetail} />}
    </aside>
  );
}

/**
 * Every conversation of the project as one toggle list: the coordinator's chat sessions, then the agents opened from
 * the network. Collapsed it is one row naming the open conversation; expanded it lists them all.
 */
function Conversations({ project, s, tabs, byId, active, viewing, onActivate, onClose, tools }: {
  project: Project; s: Plexus; tabs: string[]; byId: Map<string, Task>; active: string; viewing: boolean;
  onActivate: (id: string) => void; onClose: (id: string) => void; tools: ReactNode;
}) {
  const [open, setOpen] = useStored('plexus.chat.list', false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; c: ChatSession } | null>(null);
  const onError = s.setError;
  const pick = (id: string) => { setDeleting(null); s.setSessionId(id); onActivate(COORDINATOR); };
  const create = () => api<ChatSession>('POST', `/api/projects/${project.id}/chat-sessions`, {}).then(c => { s.loadSessions(); pick(c.id); }).catch(e => onError(e.message));
  const rename = (id: string, v: string) => {
    setRenaming(null);
    const t = v.trim();
    if (t) api('PATCH', `/api/chat-sessions/${id}`, { title: t }).then(s.loadSessions).catch(e => onError(e.message));
  };
  const remove = (id: string) => { setDeleting(null); api('DELETE', `/api/chat-sessions/${id}`).then(s.loadSessions).catch(e => onError(e.message)); };
  const menuAt = (e: React.KeyboardEvent<HTMLElement>, c: ChatSession) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left + 16, y: r.bottom, c }); };

  const onCoord = active === COORDINATOR;
  const current = s.sessions.find(x => x.id === s.sessionId);
  const task = onCoord ? undefined : byId.get(active);
  const unread = s.sessions.reduce((n, x) => n + (viewing && x.id === s.sessionId ? 0 : x.unread), 0);
  const busy = Object.keys(s.thinking).length > 0;
  const openTasks = tabs.map(id => byId.get(id)).filter((t): t is Task => !!t);
  const total = s.sessions.length + openTasks.length;

  return (
    <div className={`convs ${open ? 'open' : ''}`}>
      <div className="convs-head">
        <button className="convs-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)} title={open ? 'Hide conversations' : 'Show all conversations'}>
          <span className="convs-chev"><Ic i={ChevronRight} size={14} /></span>
          {task
            ? <><Dot state={task.status} /><span className="num convs-id">T{task.seq}</span><span className="convs-title">{task.title}</span></>
            : <><Dot state={busy ? 'running' : 'idle'} /><span className="convs-id">Coordinator</span><span className="convs-title">{current?.title || 'New chat'}</span></>}
          {!open && unread > 0 && <span className="unread-dot" title={`${unread} unread`}>{unread > 9 ? '9+' : unread}</span>}
          {!open && total > 1 && <span className="convs-count num" title="Conversations">{total}</span>}
        </button>
        {tools}
      </div>
      {open && (
        <div className="convs-list" role="listbox" aria-label="Conversations">
          <div className="convs-group"><span>Coordinator</span><button className="icon-btn" title="New chat" aria-label="New chat" onClick={create}><Ic i={Plus} size={14} /></button></div>
          {s.sessions.map(x => {
            const on = onCoord && x.id === s.sessionId;
            if (renaming === x.id) return (
              <div key={x.id} className="conv editing">
                <input autoFocus defaultValue={x.title} aria-label="Chat name" onFocus={e => e.currentTarget.select()} onBlur={e => rename(x.id, e.currentTarget.value)}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(null); }} />
              </div>
            );
            return (
              <div key={x.id} role="option" aria-selected={on} tabIndex={0} className={`conv ${on ? 'active' : ''} ${menu?.c.id === x.id ? 'menu-open' : ''}`} title={x.title || 'New chat'}
                onClick={() => pick(x.id)} onDoubleClick={() => setRenaming(x.id)}
                onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, c: x }); }}
                onKeyDown={e => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter') pick(x.id);
                  if (e.key === 'F2') setRenaming(x.id);
                  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); menuAt(e, x); }
                }}>
                <span className="conv-title">{x.title || 'New chat'}</span>
                {s.thinking[x.id] && <span className="typing live" title="Coordinator is answering"><span /><span /><span /></span>}
                {deleting === x.id ? (
                  <>
                    <span className="conv-ask">Delete?</span>
                    <button className="conv-btn danger" title="Delete this chat and its messages" onClick={e => { e.stopPropagation(); remove(x.id); }}><Ic i={Check} size={14} /></button>
                    <button className="conv-btn" title="Keep" onClick={e => { e.stopPropagation(); setDeleting(null); }}><Ic i={X} size={14} /></button>
                  </>
                ) : (
                  <>
                    {x.unread > 0 && !on && <span className="unread-dot" title={`${x.unread} unread`}>{x.unread > 9 ? '9+' : x.unread}</span>}
                    <span className="conv-meta num">{timeAgo(x.updatedAt)}</span>
                    <button className="conv-btn hover" title="Rename (F2)" onClick={e => { e.stopPropagation(); setRenaming(x.id); }}><Ic i={Pencil} size={14} /></button>
                    {s.sessions.length > 1 && <button className="conv-btn hover" title="Delete chat" onClick={e => { e.stopPropagation(); setDeleting(x.id); }}><Ic i={Trash2} size={14} /></button>}
                  </>
                )}
              </div>
            );
          })}
          {openTasks.length > 0 && <div className="convs-group"><span>Agents</span></div>}
          {openTasks.map(t => (
            <div key={t.id} role="option" aria-selected={active === t.id} tabIndex={0} className={`conv ${active === t.id ? 'active' : ''}`} title={t.title}
              onClick={() => onActivate(t.id)} onAuxClick={e => { if (e.button === 1) onClose(t.id); }}
              onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter') onActivate(t.id); if (e.key === 'Delete') onClose(t.id); }}>
              <Dot state={t.status} /><span className="num conv-seq">T{t.seq}</span>
              <span className="conv-title">{t.title}</span>
              <span className="conv-meta">{t.role}</span>
              <button className="conv-btn" title="Close" onClick={e => { e.stopPropagation(); onClose(t.id); }}><Ic i={X} size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
        { label: 'Rename', icon: Pencil, onSelect: () => setRenaming(menu.c.id) },
        { label: 'Delete chat', icon: Trash2, danger: true, disabled: s.sessions.length < 2, onSelect: () => setDeleting(menu.c.id) },
      ]} />}
    </div>
  );
}

// ---------------------------------------------------------------- coordinator

function useFollow(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [dep]);
  const onScroll = () => { const el = ref.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; };
  return { ref, onScroll };
}

const AUTHOR: Record<ChatMessage['author'], string> = { user: 'You', coordinator: 'Coordinator', agent: 'Agent', system: 'Plexus' };

const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude', codex: 'Codex', mock: 'Mock' };

/**
 * Account, model and effort the coordinator answers with, stored in the project settings.
 * Folded it is one chip naming the current choice; the chip opens a panel above the message box.
 */
/** "Claude opus", but "Claude Opus 5" stays as is instead of becoming "Claude Claude Opus 5". */
const withProvider = (provider: string, model: string) => (model.toLowerCase().startsWith(provider.toLowerCase()) ? model : `${provider} ${model}`);

function useCoordinatorOptions(project: Project, accounts: Account[], onError: (e: string) => void, reload: () => void, tick = 0) {
  const [coordRole, setCoordRole] = useState<Role | null>(null);
  useEffect(() => { api<Role[]>('GET', '/api/roles').then(r => setCoordRole(r.find(x => x.name === 'coordinator') ?? null)).catch(() => {}); }, []);
  const roleModels = coordRole?.models ?? {}, roleEfforts = coordRole?.efforts ?? {};
  const catalog = useModels();
  const saved = project.settings.coordinatorModels ?? {};
  const savedEfforts = project.settings.coordinatorEfforts ?? {};
  const pinnedId = project.settings.coordinatorAccountId ?? null;
  const pinned = pinnedId ? accounts.find(a => a.id === pinnedId) : undefined;
  const providers: Provider[] = pinned ? [pinned.provider] : [...new Set(accounts.filter(a => a.enabled).map(a => a.provider))];
  const save = (settings: Partial<Project['settings']>) =>
    api('PATCH', `/api/projects/${project.id}`, { settings }).then(reload).catch(e => onError(e.message));

  // The account the backend would answer the next message on (automatic selection, or the fallback of an unavailable pin).
  // Re-asked whenever the settings, the accounts' states or the conversation change.
  const [target, setTarget] = useState<{ accountId: string | null; provider: Provider | null; fallback: boolean } | null>(null);
  const accountsKey = accounts.map(a => `${a.id}:${a.enabled}:${a.state}:${a.cooldownUntil ?? ''}`).join('|');
  const settingsKey = JSON.stringify([pinnedId, saved, savedEfforts]);
  useEffect(() => {
    let live = true;
    api<{ accountId: string | null; provider: Provider | null; fallback: boolean }>('GET', `/api/projects/${project.id}/coordinator-target`)
      .then(t => { if (live) setTarget(t); }).catch(() => {});
    return () => { live = false; };
  }, [project.id, accountsKey, settingsKey, tick]);
  const answering = target?.accountId ? accounts.find(a => a.id === target.accountId) : undefined;

  // What the chip shows: the account, then the model and effort of the provider that will actually answer.
  const p = target ? target.provider ?? undefined : pinned?.provider ?? providers[0];
  const model = p ? saved[p] || roleModels[p] : undefined;
  const effort = p ? savedEfforts[p] || roleEfforts[p] || effortsFor(catalog, p, model).defaultEffort || undefined : undefined;
  const answeringName = answering ? answering.label || answering.id : target?.accountId ?? null;
  const summary = {
    account: pinned && !target?.fallback ? pinned.label || pinned.id
      : pinnedId ? `${pinned ? pinned.label || pinned.id : `${pinnedId} (missing)`}${answeringName ? ` → ${answeringName}` : ''}`
      : answeringName ? `Automatic · ${answeringName}` : 'Automatic',
    model: p ? withProvider(PROVIDER_NAME[p], modelLabel(catalog, p, model)) : 'No account',
    effort,
    state: pinned ? (pinned.enabled ? pinned.state : 'disabled') : null,
  };
  return { catalog, saved, savedEfforts, roleModels, roleEfforts, pinnedId, pinned, providers, save, summary };
}

function CoordinatorPicker({ o, accounts, onClose }: { o: ReturnType<typeof useCoordinatorOptions>; accounts: Account[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const out = (e: MouseEvent) => { const t = e.target as HTMLElement; if (!ref.current?.contains(t) && !t.closest('.coord-chip')) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    addEventListener('mousedown', out); ref.current?.addEventListener('keydown', key);
    const el = ref.current;
    return () => { removeEventListener('mousedown', out); el?.removeEventListener('keydown', key); };
  }, [onClose]);
  const enabled = accounts.filter(a => a.enabled);
  return (
    <div ref={ref} className="coord-panel" role="dialog" aria-label="Coordinator model">
      <div className="coord-panel-head">
        <span>Coordinator answers with</span>
        <button className="icon-btn" title="Close" aria-label="Close" onClick={onClose}><Ic i={X} size={14} /></button>
      </div>
      <div className="me coord-me">
        <div className="me-row">
          <span className="me-label">Account</span>
          <div className="seg" role="radiogroup" aria-label="Account">
            <button role="radio" aria-checked={!o.pinnedId} title="Plexus picks an account with quota left" onClick={() => void o.save({ coordinatorAccountId: null })}>Automatic</button>
            {enabled.map(a => (
              <button key={a.id} role="radio" aria-checked={o.pinnedId === a.id} title={`${a.id} · ${PROVIDER_NAME[a.provider]}${a.state === 'ok' ? '' : ` · ${label(a.state)}`}`}
                onClick={() => void o.save({ coordinatorAccountId: a.id })}>
                <Dot state={a.state} />{a.label || a.id}
              </button>
            ))}
            {o.pinnedId && !o.pinned && <button role="radio" aria-checked className="warn" title="This account no longer exists">{o.pinnedId}</button>}
          </div>
        </div>
      </div>
      {o.providers.map(p => (
        <div key={p} className="coord-provider">
          {!o.pinned && o.providers.length > 1 && <div className="coord-provider-name">On {PROVIDER_NAME[p]} accounts</div>}
          <ModelEffort className="coord-me" provider={p} catalog={o.catalog} model={o.saved[p]} effort={o.savedEfforts[p]}
            inherited={{ model: o.roleModels[p], effort: o.roleEfforts[p] }}
            onModel={m => void o.save({ coordinatorModels: { ...o.saved, [p]: m } })}
            onEffort={v => void o.save({ coordinatorEfforts: { ...o.savedEfforts, [p]: v } })} />
        </div>
      ))}
      {!o.providers.length && <div className="sub coord-empty">Enable an account in Settings to choose a model</div>}
    </div>
  );
}

function CoordinatorChat({ project, accounts, sessionId, messages, thinking, onError, reload }: { project: Project; accounts: Account[]; sessionId: string | null; messages: ChatMessage[]; thinking: string | null; onError: (e: string) => void; reload: () => void }) {
  const [text, setText] = useState('');
  const [picking, setPicking] = useState(false);
  const closePicker = useCallback(() => setPicking(false), []);
  const opts = useCoordinatorOptions(project, accounts, onError, reload, messages.length);
  const follow = useFollow(`${sessionId}:${messages.length}:${thinking}`);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    await api('POST', `/api/projects/${project.id}/messages`, { text: t, sessionId }).catch(e => onError(e.message));
  };
  const decide = (id: number, approve: boolean) => api('POST', `/api/messages/${id}/proposal`, { approve }).catch(e => onError(e.message));
  return (
    <div className="chat">
      <div className="stream" ref={follow.ref} onScroll={follow.onScroll}>
        {!messages.length && <div className="stream-empty">Ask the coordinator about progress, or give Plexus a direction</div>}
        {messages.map(m => {
          const prop = m.meta?.proposal as any;
          const level = (m.meta?.level as string) ?? '';
          return (
            <div key={m.id} className={`msg m-${m.author} ${level}`}>
              <div className="msg-head"><span className="msg-who">{AUTHOR[m.author]}</span><span className="msg-meta num">{clock(m.createdAt)}{m.meta?.account ? ` · ${m.meta.account}` : ''}{m.meta?.model ? ` · ${m.meta.model}` : ''}{m.meta?.tokens ? <> · <Tokens u={m.meta.tokens as TokenUsage} unit /></> : null}</span></div>
              <div className="msg-text">{m.text}</div>
              {Array.isArray(m.meta?.applied) && (m.meta!.applied as string[]).length > 0 && <div className="msg-applied">Applied: {(m.meta!.applied as string[]).join(', ')}</div>}
              {prop && (
                <div className="proposal">
                  <div className="proposal-title">Proposal</div>
                  <div>{prop.summary}</div>
                  <ul>{prop.actions.map((a: any, i: number) => <li key={i}><code>{a.type}</code> {a.title ?? a.task_id ?? a.text ?? a.reason ?? a.goal ?? ''}</li>)}</ul>
                  {prop.status === 'pending'
                    ? <div className="row"><button className="primary" onClick={() => decide(m.id, true)}>Approve</button><button onClick={() => decide(m.id, false)}>Reject</button></div>
                    : <div className="msg-meta">{label(prop.status)}</div>}
                </div>
              )}
            </div>
          );
        })}
        {thinking && <div className="msg m-coordinator"><div className="msg-head"><span className="msg-who">Coordinator</span><span className="msg-meta">thinking on {thinking}</span></div><div className="typing"><span /><span /><span /></div></div>}
      </div>
      <div className="composer">
        {picking && <CoordinatorPicker o={opts} accounts={accounts} onClose={closePicker} />}
        <textarea value={text} rows={3} placeholder="Message the coordinator" onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <div className="composer-bar">
          <button className="coord-chip" aria-expanded={picking} onClick={() => setPicking(v => !v)} title="Choose the account, model and effort the coordinator uses">
            {opts.summary.state && <Dot state={opts.summary.state} />}
            <span className="coord-chip-acct">{opts.summary.account}</span>
            <span className="coord-chip-model">{opts.summary.model}</span>
            {opts.summary.effort && <span className="coord-chip-effort">{opts.summary.effort}</span>}
            <Ic i={ChevronDown} size={14} />
          </button>
          <button className="primary icon-send" disabled={!text.trim() || !sessionId} onClick={send} title="Send (Enter). Shift + Enter for a new line"><Ic i={ArrowUp} /></button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sub-agent

interface RunRow { id: number; accountId: string; startedAt: string; endedAt: string | null; outcome: string | null; classification?: { reason?: string }; usage?: TokenUsage | null }
interface LogData { run: RunRow | null; prompt: string; events: { kind: string; text: string }[] }

function AgentChat({ task, accounts, logTick, onError, reload }: { task: Task; accounts: Account[]; logTick: number; onError: (e: string) => void; reload: () => void }) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [run, setRun] = useState<number | null>(null);
  const [data, setData] = useState<LogData | null>(null);
  const isRunning = task.status === 'running';
  const last = useRef(0);

  useEffect(() => { api<{ runs: RunRow[] }>('GET', `/api/tasks/${task.id}`).then(d => setRuns(d.runs)).catch(() => {}); }, [task.id, task.status, task.attempts]);
  useEffect(() => {
    // While the agent streams, refresh at most every 1.5 s; otherwise load once.
    const now = Date.now();
    const wait = Math.max(0, 1500 - (now - last.current));
    const h = setTimeout(() => {
      last.current = Date.now();
      api<LogData>('GET', `/api/tasks/${task.id}/log${run ? `?run=${run}` : ''}`).then(d => setData({ run: d.run ?? null, prompt: d.prompt ?? '', events: d.events ?? [] })).catch(() => {});
    }, isRunning && last.current ? wait : 0);
    return () => clearTimeout(h);
  }, [task.id, run, isRunning ? logTick : 0, task.status]);

  const follow = useFollow(data?.events.length);
  const act = (a: string) => api('POST', `/api/tasks/${task.id}/${a}`).then(reload).catch(e => onError(e.message));
  const [note, setNote] = useState('');
  // Done: give more work to this same agent (its conversation and worktree). Otherwise: a message for its next run.
  const finished = ['done', 'failed', 'cancelled'].includes(task.status);
  const sendNote = () => {
    const text = note.trim();
    if (!text) return;
    const req = finished ? api('POST', `/api/tasks/${task.id}/continue`, { instructions: text }) : api('POST', `/api/tasks/${task.id}/message`, { text });
    req.then(() => { setNote(''); reload(); }).catch(e => onError(e.message));
  };
  const shown = runs.find(r => r.id === (run ?? data?.run?.id));
  const acct = accounts.find(a => a.id === (shown?.accountId ?? task.accountId ?? task.lastAccountId));
  const counted = runs.filter(r => r.usage).length;
  const total = sumUsage(runs.map(r => r.usage));

  return (
    <div className="chat agent">
      <header className="agent-head">
        <div className="agent-title"><Dot state={task.status} /><span className="num">T{task.seq}</span><span className="agent-name">{task.title}</span></div>
        <div className="agent-meta">
          <span>{task.role}</span><span>{label(task.status)}</span>
          {acct && <span>{acct.label}</span>}
          {task.attempts > 0 && <span className="num">attempt {task.attempts}</span>}
          {total && <Tokens u={total} unit />}
          {task.branch && <span className="mono">{task.branch}</span>}
        </div>
        {task.paths.length > 0 && <div className="agent-paths mono" title="Files this task expects to change">{task.paths.join('  ')}</div>}
        <div className="agent-actions">
          {runs.length > 1 && (
            <select value={run ?? ''} onChange={e => setRun(e.target.value ? Number(e.target.value) : null)} title="Run">
              <option value="">Latest run</option>
              {runs.map((r, i) => <option key={r.id} value={r.id}>Run {i + 1} · {r.accountId} · {r.outcome ?? 'running'}{r.usage ? ` · ${r.usage.partial ? '≥' : ''}${fmtTokens(r.usage.total)}` : ''}</option>)}
            </select>
          )}
          <span className="spacer" />
          {['failed', 'cancelled', 'interrupted', 'blocked'].includes(task.status) && <button onClick={() => act('retry')}><Ic i={RotateCcw} />Retry</button>}
          {!['done', 'cancelled'].includes(task.status) && <button className="danger" onClick={() => act('cancel')}><Ic i={Square} />Cancel</button>}
        </div>
      </header>

      <div className="stream" ref={follow.ref} onScroll={follow.onScroll}>
        <details className="io">
          <summary><Ic i={ChevronRight} size={14} />Input<span className="io-meta">{data?.prompt
            ? `${(data.prompt.length / 1000).toFixed(1)}k chars (≈${fmtTokens(Math.round(data.prompt.length / 3.5))} tokens) from Plexus${shown?.usage?.firstCtx ? ` · first call ${fmtTokens(shown.usage.firstCtx)} tokens with the CLI's own prompt · largest ${fmtTokens(shown.usage.maxCtx ?? 0)} · ${shown.usage.calls} calls` : ''}`
            : 'task description'}</span></summary>
          {task.description && <pre className="pre">{task.description}</pre>}
          {data?.prompt && <><div className="io-label">Full prompt</div><pre className="pre">{data.prompt}</pre></>}
        </details>

        <div className="io-label">Output</div>
        {!data && <div className="stream-empty">Loading</div>}
        {data && !data.run && <div className="stream-empty">{task.status === 'pending' ? 'Waiting for an account and its dependencies' : 'No runs yet'}</div>}
        {data?.events.map((e, i) => (
          e.kind === 'text'
            ? <div key={i} className="msg m-agent"><div className="msg-text">{e.text}</div></div>
            : <div key={i} className={`evt k-${e.kind}`}><span className="evt-kind">{e.kind === 'tool' ? 'tool' : 'status'}</span><span className="evt-text">{e.text}</span></div>
        ))}
        {isRunning && data?.run && <div className="typing live"><span /><span /><span /></div>}
        {task.status !== 'cancelled' && (
          <div className="agent-note">
            <textarea rows={2} value={note} onChange={e => setNote(e.target.value)}
              placeholder={finished ? 'More work for this agent (continues its conversation and worktree)' : task.status === 'blocked' ? 'Answer the agent: it waits for this' : 'Message for this agent (delivered with its next run)'}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendNote(); } }} />
            <button onClick={sendNote} disabled={!note.trim()}><Ic i={ArrowUp} />{finished ? 'Continue' : 'Send'}</button>
          </div>
        )}

        {task.result && (
          <div className="result">
            <div className="io-label">Result · {task.result.status}</div>
            <div className="msg-text">{task.result.summary}</div>
            {task.result.review && <div className="review"><b>Review: {task.result.review.verdict.replace('_', ' ')}</b>{task.result.review.comments.map((c, i) => <div key={i}>{c}</div>)}</div>}
          </div>
        )}
        {total && (
          <div className="result">
            <div className="io-label">Tokens · {counted === 1 ? '1 run' : `${counted} runs`}</div>
            <UsageBreakdown u={total} />
          </div>
        )}
        {task.error && task.status !== 'done' && <div className="result err"><div className="io-label">Last error</div><pre className="pre">{task.error}</pre></div>}
        {shown?.classification?.reason && <div className="evt k-status"><span className="evt-kind">run</span><span className="evt-text">{shown.classification.reason}</span></div>}
      </div>
      <div className="agent-foot">Read only · steer Plexus from the Coordinator tab</div>
    </div>
  );
}

/** Sum of run totals, done here so the panel needs nothing beyond its runs. */
function sumUsage(list: (TokenUsage | null | undefined)[]): TokenUsage | null {
  const xs = list.filter((u): u is TokenUsage => !!u);
  if (!xs.length) return null;
  const add = (k: 'input' | 'cacheRead' | 'cacheWrite' | 'output' | 'reasoning' | 'total') => xs.reduce((a, u) => a + u[k], 0);
  const costs = xs.map(u => u.costUsd).filter((v): v is number => v != null);
  const byModel: TokenUsage['byModel'] = {};
  for (const u of xs) for (const [m, t] of Object.entries(u.byModel)) {
    const p = byModel[m];
    byModel[m] = p ? {
      input: p.input + t.input, cacheRead: p.cacheRead + t.cacheRead, cacheWrite: p.cacheWrite + t.cacheWrite, output: p.output + t.output, reasoning: p.reasoning + t.reasoning,
      costUsd: p.costUsd == null && t.costUsd == null ? null : (p.costUsd ?? 0) + (t.costUsd ?? 0),
    } : t;
  }
  return {
    input: add('input'), cacheRead: add('cacheRead'), cacheWrite: add('cacheWrite'), output: add('output'), reasoning: add('reasoning'), total: add('total'),
    costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null, byModel, ...(xs.some(u => u.partial) ? { partial: true } : {}),
  };
}
