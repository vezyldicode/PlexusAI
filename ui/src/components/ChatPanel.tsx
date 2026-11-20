import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Check, ChevronDown, ChevronRight, PanelRightClose, PanelRightOpen, Pencil, Plus, RotateCcw, Square, Trash2, X, type LucideIcon } from 'lucide-react';
import { api, clock, timeAgo } from '../api.ts';
import type { ProjectDetail, Plexus } from '../store.ts';
import type { Account, ChatMessage, ChatSession, Project, Provider, Role, RunTiming, Task, TaskModelInfo, TokenUsage } from '../types.ts';
import { ContextMenu, Dot, Ic, label, Tokens, UsageBreakdown, fmtTokens } from '../ui.tsx';
import { useStored } from '../layout.tsx';
import { COORDINATOR } from '../network/layout.ts';
import { effortsFor, shownModel, useModels } from '../models.tsx';
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
        : <AgentChat key={active} task={byId.get(active)!} info={detail.models?.[active]} accounts={s.accounts} logTick={s.logTick} onError={s.setError} reload={s.loadDetail} />}
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
  // Choosing a conversation folds the list back to the one row naming it.
  const pick = (id: string) => { setDeleting(null); s.setSessionId(id); onActivate(COORDINATOR); setOpen(false); };
  const pickAgent = (id: string) => { onActivate(id); setOpen(false); };
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
              onClick={() => pickAgent(t.id)} onAuxClick={e => { if (e.button === 1) onClose(t.id); }}
              onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter') pickAgent(t.id); if (e.key === 'Delete') onClose(t.id); }}>
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
          // Your message, and under it the prompt Plexus turned it into (when that turn's log exists).
          if (m.author === 'user' && typeof m.meta?.promptChars === 'number') return (
            <div key={m.id} className="ask">
              <div className="msg m-user"><div className="msg-text">{m.text}</div></div>
              <PromptToggle url={`/api/messages/${m.id}/prompt`} chars={m.meta.promptChars as number} note={m.meta.promptResumed ? 'resumed' : 'new conversation'} />
            </div>
          );
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


/** First line of a text, cut to a short summary. */
const brief = (s: string, n = 140) => { const l = s.trim().split('\n').find(x => x.trim())?.trim() ?? ''; return l.length > n ? `${l.slice(0, n - 1)}…` : l; };

/** An icon button whose label shows as a tooltip on hover or keyboard focus. */
const TipButton = ({ icon, label: text, onClick, danger }: { icon: LucideIcon; label: string; onClick: () => void; danger?: boolean }) => (
  <button className={`icon-btn tip ${danger ? 'danger' : ''}`} aria-label={text} data-tip={text} onClick={onClick}><Ic i={icon} /></button>
);

/** The total of a task's runs; where it went (and how large the context got) shows on hover. */
function TokenStat({ total, runs, run }: { total: TokenUsage; runs: number; run?: TokenUsage | null }) {
  return (
    <span className="tok-hover" tabIndex={0} aria-label={`${fmtTokens(total.total)} tokens, details on hover`}>
      <span className="num">{total.partial ? '≥' : ''}{fmtTokens(total.total)} tokens</span>
      <span className="tok-pop" role="tooltip">
        <span className="tok-pop-head">{runs === 1 ? '1 run' : `${runs} runs`}</span>
        <UsageBreakdown u={total} />
        {run?.calls ? <span className="tok-pop-ctx num">Last run: {run.calls} calls · first {fmtTokens(run.firstCtx ?? 0)} · largest {fmtTokens(run.maxCtx ?? 0)} tokens of context</span> : null}
      </span>
    </span>
  );
}

const FROM: Record<TaskModelInfo['modelFrom'], string> = { task: 'set for this task', coordinator: 'coordinator setting', role: 'role default', plexus: 'Plexus default for the role', default: 'CLI default' };

/** Account, model and effort for one task: what its next run (or its continuation) uses. Disabled while it runs. */
function AgentPicker({ task, info, accounts, catalog, onError, reload, onClose }: {
  task: Task; info: TaskModelInfo; accounts: Account[]; catalog: ReturnType<typeof useModels>; onError: (e: string) => void; reload: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const out = (e: MouseEvent) => { const t = e.target as HTMLElement; if (!ref.current?.contains(t) && !t.closest('.coord-chip')) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    addEventListener('mousedown', out); ref.current?.addEventListener('keydown', key);
    const el = ref.current;
    return () => { removeEventListener('mousedown', out); el?.removeEventListener('keydown', key); };
  }, [onClose]);
  const patch = (body: Record<string, unknown>) => api('PATCH', `/api/tasks/${task.id}`, body).then(reload).catch(e => onError(e.message));
  const enabled = accounts.filter(a => a.enabled);
  const pinned = task.pinnedAccountId ? accounts.find(a => a.id === task.pinnedAccountId) : undefined;
  const providers: Provider[] = pinned ? [pinned.provider] : [...new Set([info.provider, ...enabled.map(a => a.provider)])];
  const finished = ['done', 'failed', 'cancelled'].includes(task.status);
  return (
    <div ref={ref} className="coord-panel" role="dialog" aria-label={`T${task.seq} model`}>
      <div className="coord-panel-head">
        <span>{finished ? 'Used when you continue this agent' : 'Used from its next run'}</span>
        <button className="icon-btn" title="Close" aria-label="Close" onClick={onClose}><Ic i={X} size={14} /></button>
      </div>
      <div className="me coord-me">
        <div className="me-row">
          <span className="me-label">Account</span>
          <div className="seg" role="radiogroup" aria-label="Account">
            <button role="radio" aria-checked={!task.pinnedAccountId} title="Plexus picks an account with quota left" onClick={() => void patch({ pinnedAccountId: null })}>Automatic</button>
            {enabled.map(a => (
              <button key={a.id} role="radio" aria-checked={task.pinnedAccountId === a.id} title={`${a.id} · ${PROVIDER_NAME[a.provider]} · another account takes over while it cannot run`}
                onClick={() => void patch({ pinnedAccountId: a.id })}>
                <Dot state={a.state} />{a.label || a.id}
              </button>
            ))}
          </div>
        </div>
      </div>
      {providers.map(p => (
        <div key={p} className="coord-provider">
          {providers.length > 1 && <div className="coord-provider-name">On {PROVIDER_NAME[p]} accounts</div>}
          <ModelEffort className="coord-me" provider={p} catalog={catalog} model={task.models?.[p]} effort={task.efforts?.[p]}
            inherited={p === info.provider ? { model: info.modelFrom !== 'task' ? info.model ?? undefined : undefined, effort: info.effortFrom !== 'task' ? info.effort ?? undefined : undefined } : undefined}
            onModel={m => void patch({ models: { ...task.models, [p]: m } })}
            onEffort={v => void patch({ efforts: { ...task.efforts, [p]: v } })} />
        </div>
      ))}
    </div>
  );
}

/**
 * The exact prompt a message became, under that message. Loaded when opened (prompts run to tens of thousands of
 * characters, so the chat does not carry them).
 */
function PromptToggle({ url, chars, note }: { url: string; chars: number; note?: string }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <details className="ptog" onToggle={e => {
      if (!e.currentTarget.open || text !== null) return;
      api<{ prompt: string }>('GET', url).then(r => setText(r.prompt || '(empty)')).catch(() => setText('(the prompt could not be loaded)'));
    }}>
      <summary><Ic i={ChevronRight} size={14} /><span>Full prompt</span><span className="ptog-meta num">{(chars / 1000).toFixed(1)}k chars · ≈{fmtTokens(Math.round(chars / 3.5))} tokens{note ? ` · ${note}` : ''}</span></summary>
      <pre className="pre">{text ?? 'Loading'}</pre>
    </details>
  );
}

interface TurnRow { kind?: 'checkpoint' | 'fork' | null; resuming: string | null; at: string | null; promptChars: number; messages: string[]; events: { kind: string; text: string }[] }
interface RunTurns { id: number; accountId: string; startedAt: string; endedAt: string | null; outcome: string | null; usage?: TokenUsage | null; model: string | null; effort: string | null; reason: string | null; timing?: RunTiming | null; turns: TurnRow[] }

/** What a turn asked the agent, in words: the task, the messages delivered with it, or why it ran again. */
function askOf(task: Task, run: RunTurns, ri: number, x: TurnRow, ti: number): string {
  if (x.kind === 'checkpoint') return 'Context budget spent (compacted too often): commit, note what is left and report';
  if (ri === 0 && ti === 0) return task.description || task.title;
  if (x.messages.length) return x.messages.join('\n');
  if (ti > 0) return 'The earlier conversation could not be resumed: starting a new one';
  return x.resuming ? `Retry on ${run.accountId}, continuing the same conversation` : `Attempt ${ri + 1} on ${run.accountId}`;
}

function AgentChat({ task, info, accounts, logTick, onError, reload }: { task: Task; info: TaskModelInfo | undefined; accounts: Account[]; logTick: number; onError: (e: string) => void; reload: () => void }) {
  const [runs, setRuns] = useState<RunTurns[] | null>(null);
  const [text, setText] = useState('');
  const [picking, setPicking] = useState(false);
  const closePicker = useCallback(() => setPicking(false), []);
  const catalog = useModels();
  const isRunning = task.status === 'running';
  const last = useRef(0);

  useEffect(() => {
    // While the agent streams, refresh at most every 1.5 s; otherwise load once.
    const wait = Math.max(0, 1500 - (Date.now() - last.current));
    const h = setTimeout(() => {
      last.current = Date.now();
      api<{ runs: RunTurns[] }>('GET', `/api/tasks/${task.id}/turns`).then(d => setRuns(d.runs)).catch(() => {});
    }, isRunning && last.current ? wait : 0);
    return () => clearTimeout(h);
  }, [task.id, isRunning ? logTick : 0, task.status, task.attempts]);

  const follow = useFollow(`${task.id}:${runs?.length}:${runs?.at(-1)?.turns.reduce((n, x) => n + x.events.length, 0)}`);
  const act = (a: string) => api('POST', `/api/tasks/${task.id}/${a}`).then(reload).catch(e => onError(e.message));
  // Finished: more work for this same agent (its conversation and worktree). Otherwise: a message for its next run.
  const finished = ['done', 'failed', 'cancelled'].includes(task.status);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    const req = finished ? api('POST', `/api/tasks/${task.id}/continue`, { instructions: t }) : api('POST', `/api/tasks/${task.id}/message`, { text: t });
    req.then(reload).catch(e => { setText(t); onError(e.message); });
  };
  const lastRun = runs?.at(-1);
  const acct = accounts.find(a => a.id === (lastRun?.accountId ?? task.accountId ?? task.lastAccountId));
  const total = sumUsage((runs ?? []).map(r => r.usage));
  const canRetry = ['failed', 'cancelled', 'interrupted', 'blocked'].includes(task.status);
  const canCancel = !['done', 'cancelled'].includes(task.status);

  // The chip: the account and model in use (running) or for the next run.
  const pinned = task.pinnedAccountId ? accounts.find(a => a.id === task.pinnedAccountId) : undefined;
  const chipAcct = isRunning && acct ? acct.label || acct.id : pinned ? pinned.label || pinned.id : acct ? acct.label || acct.id : 'Automatic';
  const sm = shownModel(info);
  const chipModel = info ? withProvider(PROVIDER_NAME[info.provider], modelLabel(catalog, info.provider, sm.model)) : 'Model';
  const chipTitle = !info ? 'Model and effort' : !info.editable ? 'Running: the model and effort of a run cannot change while it runs'
    : `Model: ${FROM[info.modelFrom]} · effort: ${FROM[info.effortFrom]}. Click to change`;

  // Last error, or the result, folded above the message box.
  const failedNow = !!task.error && task.status !== 'done';
  const r = task.result;
  const report = failedNow ? { kind: 'err', label: 'Error', short: brief(task.error!) }
    : r ? { kind: r.status === 'done' ? 'ok' : 'warn', label: `Result · ${r.status}`, short: brief(r.summary || '(no summary)') } : null;
  const failing = r?.evaluation?.criteria.filter(c => c.pass !== true) ?? [];

  return (
    <div className="chat agent">
      <header className="agent-head">
        <div className="agent-title">
          <Dot state={task.status} /><span className="num">T{task.seq}</span><span className="agent-name" title={task.title}>{task.title}</span>
          {canRetry && <TipButton icon={RotateCcw} label="Retry" onClick={() => void act('retry')} />}
          {canCancel && <TipButton icon={Square} label="Cancel task" danger onClick={() => void act('cancel')} />}
        </div>
        <div className="agent-meta">
          <span>{task.role}</span><span>{label(task.status)}</span>
          {acct && <span>{acct.label || acct.id}</span>}
          {task.attempts > 1 && <span className="num">attempt {task.attempts}</span>}
          {total && <span><TokenStat total={total} runs={(runs ?? []).filter(x => x.usage).length} run={lastRun?.usage} /></span>}
        </div>
      </header>

      <div className="stream" ref={follow.ref} onScroll={follow.onScroll}>
        {!runs && <div className="stream-empty">Loading</div>}
        {runs && !runs.length && (
          <>
            <div className="msg m-user"><div className="msg-text">{task.description || task.title}</div></div>
            <div className="stream-empty">{task.status === 'pending' ? 'Waiting for an account and its dependencies' : 'Not run yet'}</div>
          </>
        )}
        {runs?.map((run, ri) => (
          <div key={run.id} className="run">
            {run.turns.map((x, ti) => (
              <div key={ti} className="turn">
                <div className="ask">
                  <div className="msg m-user"><div className="msg-text">{askOf(task, run, ri, x, ti)}</div></div>
                  {x.promptChars > 0 && <PromptToggle url={`/api/tasks/${task.id}/prompt?run=${run.id}&turn=${ti}`} chars={x.promptChars}
                    note={x.kind === 'fork' ? "continues the coordinator's conversation" : x.resuming ? 'resumed' : 'new conversation'} />}
                </div>
                {x.events.map((e, i) => {
                  if (e.kind !== 'text') return <div key={i} className={`evt k-${e.kind}`}><span className="evt-kind">{e.kind === 'tool' ? 'tool' : 'status'}</span><span className="evt-text">{e.text}</span></div>;
                  const head = x.events[i - 1]?.kind !== 'text';
                  return (
                    <div key={i} className="msg m-agent">
                      {head && <div className="msg-head"><span className="msg-who">{label(task.role)}</span></div>}
                      <div className="msg-text">{e.text}</div>
                    </div>
                  );
                })}
              </div>
            ))}
            {run.endedAt && (
              <div className="evt k-status run-end">
                <span className="evt-kind">run</span>
                <span className="evt-text">{[run.outcome ?? 'ended', run.accountId, run.model, run.effort, run.usage ? `${fmtTokens(run.usage.total)} tokens` : '', run.outcome !== 'success' ? run.reason : ''].filter(Boolean).join(' · ')}</span>
              </div>
            )}
            {run.endedAt && run.timing && <RunTimeBar t={run.timing} />}
          </div>
        ))}
        {isRunning && <div className="msg m-agent"><div className="typing live"><span /><span /><span /></div></div>}
      </div>

      {report && (
        <div className="agent-dock">
          <details className={`fold fold-${report.kind}`}>
            <summary><Ic i={ChevronRight} size={14} /><span className="fold-label">{report.label}</span><span className="fold-sum">{report.short}</span></summary>
            <div className="fold-body">
              {failedNow ? <pre className="pre">{task.error}</pre> : <div className="msg-text">{r!.summary}</div>}
              {failedNow && lastRun?.reason && lastRun.reason !== task.error && <div className="fold-line">Run: {lastRun.reason}</div>}
              {!failedNow && r!.issues.length > 0 && <><div className="io-label">Open issues</div><ul className="fold-list">{r!.issues.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
              {!failedNow && failing.length > 0 && <><div className="io-label">Criteria not met</div><ul className="fold-list">{failing.map(c => <li key={c.id}><span className="num">{c.id}</span> {c.pass === 'blocked' ? 'cannot be checked here' : 'fails'}: {c.evidence}</li>)}</ul></>}
              {!failedNow && r!.review && <div className="review"><b>Review: {r!.review.verdict.replace('_', ' ')}</b>{r!.review.comments.map((c, i) => <div key={i}>{c}</div>)}</div>}
              {(task.branch || task.paths.length > 0) && <div className="fold-line mono">{[task.branch, ...task.paths].filter(Boolean).join('  ')}</div>}
            </div>
          </details>
        </div>
      )}

      <div className="composer">
        {picking && info && <AgentPicker task={task} info={info} accounts={accounts} catalog={catalog} onError={onError} reload={reload} onClose={closePicker} />}
        <textarea value={text} rows={3}
          placeholder={finished ? 'More work or a question for this agent (it continues its own conversation)' : task.status === 'blocked' ? 'Answer the agent, it waits for this' : 'Message for this agent, delivered with its next run'}
          onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <div className="composer-bar">
          <button className="coord-chip" aria-expanded={picking} disabled={!info?.editable} onClick={() => setPicking(v => !v)} title={chipTitle}>
            <span className="coord-chip-acct">{chipAcct}</span>
            <span className="coord-chip-model">{chipModel}</span>
            {sm.effort && <span className="coord-chip-effort">{sm.effort}</span>}
            <Ic i={ChevronDown} size={14} />
          </button>
          <button className="primary icon-send" disabled={!text.trim()} onClick={send}
            title={finished ? 'Continue this agent (Enter). Shift + Enter for a new line' : 'Send (Enter). Shift + Enter for a new line'}><Ic i={ArrowUp} /></button>
        </div>
      </div>
    </div>
  );
}

const dur = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/** Where a run's time went: one bar (startup, model, tools, compaction) and the numbers, plus how long it waited to start. */
function RunTimeBar({ t }: { t: RunTiming }) {
  const parts = [
    { k: 'startup', v: t.startupMs, label: 'startup' },
    { k: 'model', v: t.modelMs, label: 'model' },
    { k: 'tools', v: t.toolMs, label: `tools (${t.toolCalls})` },
    { k: 'compact', v: t.compactMs, label: `compaction (${t.compactions}×)` },
  ].filter(p => p.v > 0 || (p.k === 'compact' && t.compactions > 0));
  const total = Math.max(1, t.totalMs);
  const text = [`${dur(t.totalMs)}`, ...parts.map(p => `${p.label} ${dur(p.v)}`), t.waitMs >= 1000 ? `waited ${dur(t.waitMs)} before start` : ''].filter(Boolean).join(' · ');
  return (
    <div className="evt k-status run-time" title="Where this run's time went. Model = the model reading and writing (thinking included); tools = commands and file operations; waited = time the task waited for this run (dependencies, a free account, approval)">
      <span className="evt-kind">time</span>
      <span className="evt-text">
        <span className="tbar">{parts.map(p => <span key={p.k} className={`tbar-${p.k}`} style={{ width: `${(p.v / total) * 100}%` }} />)}</span>
        {text}
      </span>
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
