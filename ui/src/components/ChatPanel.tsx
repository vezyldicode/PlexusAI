import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Check, ChevronDown, ChevronRight, Download, FileText, Paperclip, PanelRightClose, PanelRightOpen, Pencil, Plus, RotateCcw, Square, Trash2, X, type LucideIcon } from 'lucide-react';
import { api, clock, timeAgo, token } from '../api.ts';
import type { LiveActivity, ProjectDetail, Plexus } from '../store.ts';
import type { Account, ChatActivity, ChatMessage, ChatStep, ChatSession, Project, Provider, Role, RunTiming, Task, TaskModelInfo, TokenUsage } from '../types.ts';
import { ContextMenu, Dot, Ic, label, Tokens, UsageBreakdown, fmtTokens } from '../ui.tsx';
import { useStored } from '../layout.tsx';
import { COORDINATOR } from '../network/layout.ts';
import { groupEvents, parsePlan, PlanCard, ToolGroup } from '../activity.tsx';
import { effortsFor, shownModel, useModels } from '../models.tsx';
import { ModelEffort, modelLabel } from '../settings.tsx';
import { Markdown, plain } from '../markdown.tsx';

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
  // A task asked for in the coordinator chat links back to that conversation.
  const origin = (t: Task | undefined) => {
    const sid = t?.originSessionId;
    const session = sid ? s.sessions.find(x => x.id === sid) : undefined;
    return session ? { title: session.title, open: () => { s.setSessionId(session.id); onActivate(COORDINATOR); } } : null;
  };
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
        ? <CoordinatorChat key={s.sessionId ?? ''} project={detail.project} accounts={s.accounts} sessionId={s.sessionId} messages={s.messages} thinking={s.sessionId ? s.thinking[s.sessionId] ?? null : null}
            live={s.sessionId ? s.live[s.sessionId] ?? null : null} onError={s.setError} reload={s.loadDetail} />
        : byId.get(active)!.kind === 'coordinator'
          ? <CoordinatorRecord key={active} task={byId.get(active)!} origin={origin(byId.get(active))} />
          : <AgentChat key={active} task={byId.get(active)!} origin={origin(byId.get(active))} info={detail.models?.[active]} accounts={s.accounts} logTick={s.logTick} onError={s.setError} reload={s.loadDetail} />}
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

/**
 * Keeps a stream scrolled to its end while the reader is there. `dep` changes when something new arrives; `scope`
 * names the conversation (a new one starts at its end). Sizes also change without anything new arriving: a long reply
 * lays out its code blocks, a font loads, the plan dock or the prompt toggle appears. Following only on `dep` left the
 * view parked at the top of a long reply, its heading at the bottom edge and the rest below it, until a reload
 * scrolled it to the end. A ResizeObserver on the box and on every item keeps the end in view through all of these.
 * `below` is set when something new arrives while the reader is scrolled up, so the stream can say so.
 */
function useFollow(dep: unknown, scope: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [below, setBelow] = useState(false);
  const toEnd = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    setBelow(false);
    el.scrollTop = el.scrollHeight;
  }, []);
  // A new conversation opens at its end.
  useLayoutEffect(() => { stick.current = true; setBelow(false); }, [scope]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (el.scrollHeight - el.scrollTop - el.clientHeight > 48) setBelow(true);
  }, [dep, scope]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pin = () => { if (stick.current) el.scrollTop = el.scrollHeight; };
    const ro = new ResizeObserver(pin);
    const watch = () => { ro.disconnect(); ro.observe(el); for (const c of el.children) ro.observe(c); };
    const mo = new MutationObserver(watch);
    watch();
    mo.observe(el, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, []);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (stick.current) setBelow(false);
  };
  return { ref, onScroll, below, toEnd };
}

/** Shown at the bottom of a stream when something new arrived below the part the reader is looking at. */
const JumpToEnd = ({ follow }: { follow: ReturnType<typeof useFollow> }) =>
  follow.below ? <button className="stream-jump" onClick={follow.toEnd}><Ic i={ChevronDown} size={14} />New messages below</button> : null;

const AUTHOR: Record<ChatMessage['author'], string> = { user: 'You', coordinator: 'Coordinator', agent: 'Agent', system: 'Plexus' };

const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude', codex: 'Codex', mock: 'Mock' };

/**
 * Account, model and effort the coordinator answers with, stored in the project settings.
 * Folded it is one chip naming the current choice; the chip opens a panel above the message box.
 */
/** "Claude opus", but "Claude Opus 5" stays as is instead of becoming "Claude Claude Opus 5". */
const withProvider = (provider: string, model: string) => (model.toLowerCase().startsWith(provider.toLowerCase()) ? model : `${provider} ${model}`);

function useCoordinatorOptions(project: Project, accounts: Account[], sessionId: string | null, onError: (e: string) => void, reload: () => void, tick = 0) {
  const [coordRole, setCoordRole] = useState<Role | null>(null);
  useEffect(() => { api<Role[]>('GET', '/api/roles').then(r => setCoordRole(r.find(x => x.name === 'coordinator') ?? null)).catch(() => {}); }, []);
  const roleModels = coordRole?.models ?? {}, roleEfforts = coordRole?.efforts ?? {};
  const catalog = useModels();
  const saved = project.settings.coordinatorModels ?? {};
  const savedEfforts = project.settings.coordinatorEfforts ?? {};
  const pinnedId = project.settings.coordinatorAccountId ?? null;
  const pinned = pinnedId ? accounts.find(a => a.id === pinnedId) : undefined;
  const providers: Provider[] = pinned ? [pinned.provider] : [...new Set(accounts.filter(a => a.enabled).map(a => a.provider))];
  // A change here is the default for new chats and also this chat's own choice (other chats keep theirs).
  const [saves, setSaves] = useState(0);
  const save = (settings: Partial<Project['settings']>) =>
    api('PATCH', `/api/projects/${project.id}`, { settings, ...(sessionId && { sessionId }) }).then(() => { setSaves(n => n + 1); reload(); }).catch(e => onError(e.message));

  // The account, model and effort this chat answers its next message with (its stored choice, or a new pick when that
  // account cannot run). Re-asked whenever the settings, the accounts' states or the conversation change.
  type Target = { accountId: string | null; provider: Provider | null; model: string | null; effort: string | null; fallback: boolean };
  const [target, setTarget] = useState<Target | null>(null);
  const accountsKey = accounts.map(a => `${a.id}:${a.enabled}:${a.state}:${a.cooldownUntil ?? ''}`).join('|');
  const settingsKey = JSON.stringify([pinnedId, saved, savedEfforts]);
  useEffect(() => {
    let live = true;
    api<Target>('GET', `/api/projects/${project.id}/coordinator-target${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`)
      .then(t => { if (live) setTarget(t); }).catch(() => {});
    return () => { live = false; };
  }, [project.id, sessionId, accountsKey, settingsKey, tick, saves]);
  const answering = target?.accountId ? accounts.find(a => a.id === target.accountId) : undefined;

  // What the chip shows: the account, then the model and effort of the provider that will actually answer.
  const p = target ? target.provider ?? undefined : pinned?.provider ?? providers[0];
  const model = target?.accountId ? target.model ?? undefined : p ? saved[p] || roleModels[p] : undefined;
  const effort = target?.accountId && target.effort ? target.effort : p ? savedEfforts[p] || roleEfforts[p] || effortsFor(catalog, p, model).defaultEffort || undefined : undefined;
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

const toolLines = (tools: string[]) => tools.map(text => ({ kind: 'tool', text }));

/** The coordinator's steps as the chat shows them: its words in full, each run of tool calls folded into one grey line. */
function Steps({ steps, live }: { steps: ChatStep[]; live?: boolean }) {
  const items = groupEvents(steps);
  return <>{items.map((it, i) => it.type === 'group'
    ? <ToolGroup key={i} lines={it.lines} live={live && i === items.length - 1} />
    : <Markdown key={i} className="msg-text step-text" text={it.e.text} />)}</>;
}

/** What the coordinator is doing right now, from its last step: thinking, or the tool it runs. */
function nowDoing(steps: ChatStep[]): string {
  const last = steps.at(-1);
  if (last?.kind !== 'tool') return 'Thinking';
  const name = last.text.trim().split(/\s+/)[0].replace(/^mcp__\w+?__/, '');
  return `Running ${name}`;
}

/** Time since `since`, ticking while shown: "45s", "2m 05s". */
function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return <span className="num">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`}</span>;
}

function CoordinatorChat({ project, accounts, sessionId, messages, thinking, live, onError, reload }: { project: Project; accounts: Account[]; sessionId: string | null; messages: ChatMessage[]; thinking: string | null; live: LiveActivity | null; onError: (e: string) => void; reload: () => void }) {
  const [text, setText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const uploads = useUploads(sessionId, onError);
  const [picking, setPicking] = useState(false);
  const closePicker = useCallback(() => setPicking(false), []);
  const opts = useCoordinatorOptions(project, accounts, sessionId, onError, reload, messages.length);
  const follow = useFollow(`${messages.length}:${thinking}:${live?.steps.length}`, sessionId);
  // The checklist of the turn in progress, else of the last answer to your last message.
  const lastUser = messages.findLastIndex(m => m.author === 'user');
  const answered = messages.slice(lastUser + 1).find(m => m.author === 'coordinator')?.meta?.activity as ChatActivity | undefined;
  const plan = thinking ? live?.plan ?? null : answered?.plan ?? null;
  const send = async () => {
    const t = text.trim();
    if ((!t && !uploads.items.length) || uploads.busy) return;
    try {
      follow.toEnd();
      await api('POST', `/api/projects/${project.id}/messages`, { text: t, sessionId, attachments: uploads.ids });
      setText(''); uploads.sent();
    }
    catch (e: any) { onError(e.message); }
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
              <div className="msg m-user">{m.text && <div className="msg-text">{m.text}</div>}<MessageAttachments message={m} /></div>
              <PromptToggle url={`/api/messages/${m.id}/prompt`} chars={m.meta.promptChars as number} note={m.meta.promptResumed ? 'resumed' : 'new conversation'} />
            </div>
          );
          return (
            <div key={m.id} className={`msg m-${m.author} ${level}`}>
              <div className="msg-head"><span className="msg-who">{AUTHOR[m.author]}</span><span className="msg-meta num">{clock(m.createdAt)}{m.meta?.account ? ` · ${m.meta.account}` : ''}{m.meta?.model ? ` · ${m.meta.model}` : ''}{m.meta?.tokens ? <> · <Tokens u={m.meta.tokens as TokenUsage} unit /></> : null}</span></div>
              {(() => {
                const a = m.meta?.activity as ChatActivity | undefined;
                return a?.steps?.length ? <Steps steps={a.steps} /> : a?.tools.length ? <ToolGroup lines={toolLines(a.tools)} /> : null;
              })()}
              {m.author === 'coordinator' || m.author === 'agent' ? <Markdown className="msg-text" text={m.text} /> : <div className="msg-text">{m.text}</div>}
              {m.author === 'user' && <MessageAttachments message={m} />}
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
        {thinking && (
          <div className="msg m-coordinator working" aria-live="polite">
            <div className="msg-head">
              <span className="msg-who">Coordinator</span>
              <span className="msg-meta">{nowDoing(live?.steps ?? [])}{live && <> · <Elapsed since={live.since} /></>} · {thinking}</span>
            </div>
            {live?.steps.length ? <Steps steps={live.steps} live /> : null}
            <div className="typing live"><span /><span /><span /></div>
          </div>
        )}
        <JumpToEnd follow={follow} />
      </div>
      {plan &&<div className="agent-dock"><PlanCard items={plan} live={!!thinking} /></div>}
      <div className="composer" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { e.preventDefault(); uploads.add(Array.from(e.dataTransfer.files)); }}>
        {picking && <CoordinatorPicker o={opts} accounts={accounts} onClose={closePicker} />}
        {!!uploads.items.length && <div className="chat-images">{uploads.items.map(x => (
          <div className={`chat-image${x.preview ? '' : ' chat-file'}${x.error ? ' failed' : ''}`} key={x.key} title={x.error ?? `${x.file.name} · ${fmtBytes(x.file.size)}`}>
            {x.preview ? <img src={x.preview} alt={x.file.name} /> : <FileChip name={x.file.name} size={x.file.size} />}
            {x.progress < 1 && !x.error && <div className="upload-progress"><span style={{ width: `${Math.round(x.progress * 100)}%` }} /></div>}
            <button aria-label={`Remove ${x.file.name}`} onClick={() => uploads.remove(x.key)}><Ic i={X} size={14} /></button>
          </div>))}</div>}
        <textarea value={text} rows={3} placeholder="Message the coordinator" onChange={e => setText(e.target.value)}
          onPaste={e => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); uploads.add(files); } }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <div className="composer-bar">
          <input ref={fileInput} type="file" multiple hidden onChange={e => { uploads.add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          <button aria-label="Attach files" title={`Attach files (up to ${MAX_FILES}, ${MAX_FILE_MB} MB each)`} disabled={!sessionId} onClick={() => fileInput.current?.click()}><Ic i={Paperclip} size={16} /></button>
          <button className="coord-chip" aria-expanded={picking} onClick={() => setPicking(v => !v)} title="Choose the account, model and effort the coordinator uses">
            {opts.summary.state && <Dot state={opts.summary.state} />}
            <span className="coord-chip-acct">{opts.summary.account}</span>
            <span className="coord-chip-model">{opts.summary.model}</span>
            {opts.summary.effort && <span className="coord-chip-effort">{opts.summary.effort}</span>}
            <Ic i={ChevronDown} size={14} />
          </button>
          <button className="primary icon-send" disabled={(!text.trim() && !uploads.items.length) || uploads.busy || !sessionId} onClick={send} title={uploads.busy ? 'Waiting for the files to upload' : 'Send (Enter). Shift + Enter for a new line'}><Ic i={ArrowUp} /></button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- attachments

const MAX_FILES = 20;
const MAX_FILE_MB = 30;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface Upload { key: string; file: File; preview: string | null; progress: number; id?: string; error?: string; xhr?: XMLHttpRequest }

/**
 * Files for the next message: each is uploaded as soon as it is added (with its progress), and the message then only
 * names them. Removing one cancels its upload or deletes it on the server; switching chats drops the unsent ones.
 */
function useUploads(sessionId: string | null, onError: (e: string) => void) {
  const [items, setItems] = useState<Upload[]>([]);
  const live = useRef<Upload[]>([]);
  live.current = items;
  const patch = (key: string, p: Partial<Upload>) => setItems(old => old.map(x => x.key === key ? { ...x, ...p } : x));
  const drop = (x: Upload, sid: string | null) => {
    x.xhr?.abort();
    if (x.preview) URL.revokeObjectURL(x.preview);
    if (x.id && sid) void api('DELETE', `/api/chat-sessions/${sid}/attachments/${x.id}`).catch(() => {});
  };
  useEffect(() => () => { live.current.forEach(x => drop(x, sessionId)); setItems([]); }, [sessionId]);
  const add = (files: File[]) => {
    if (!sessionId || !files.length) return;
    const big = files.filter(f => f.size > MAX_FILE_MB * 1024 * 1024);
    const empty = files.filter(f => f.size === 0);
    if (big.length) onError(`${big.map(f => f.name).join(', ')}: larger than ${MAX_FILE_MB} MB`);
    else if (empty.length) onError(`${empty.map(f => f.name).join(', ')}: empty file`);
    const ok = files.filter(f => f.size > 0 && f.size <= MAX_FILE_MB * 1024 * 1024);
    const room = MAX_FILES - live.current.length;
    if (ok.length > room) onError(`Up to ${MAX_FILES} files per message`);
    const added = ok.slice(0, Math.max(0, room)).map((file): Upload => ({
      key: `${Date.now()}-${Math.random()}`, file, progress: 0,
      preview: IMAGE_TYPES.includes(file.type) && file.size <= 10 * 1024 * 1024 ? URL.createObjectURL(file) : null,
    }));
    for (const u of added) {
      const xhr = new XMLHttpRequest();
      u.xhr = xhr;
      xhr.open('POST', `/api/chat-sessions/${sessionId}/attachments?name=${encodeURIComponent(u.file.name)}&mime=${encodeURIComponent(u.file.type)}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.setRequestHeader('x-plexus-token', token);
      xhr.upload.onprogress = e => { if (e.lengthComputable) patch(u.key, { progress: Math.min(0.99, e.loaded / e.total) }); };
      xhr.onload = () => {
        let j: any = null;
        try { j = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && j?.id) patch(u.key, { id: j.id, progress: 1, xhr: undefined });
        else { const error = j?.error ?? `upload failed (${xhr.status})`; patch(u.key, { error, xhr: undefined }); onError(`${u.file.name}: ${error}`); }
      };
      xhr.onerror = () => { patch(u.key, { error: 'upload failed', xhr: undefined }); onError(`${u.file.name}: upload failed`); };
      xhr.send(u.file);
    }
    setItems(old => [...old, ...added]);
  };
  const remove = (key: string) => {
    const x = live.current.find(y => y.key === key);
    if (x) drop(x, sessionId);
    setItems(old => old.filter(y => y.key !== key));
  };
  /** The message holding them was sent: forget them here (the server keeps them). */
  const sent = () => { live.current.forEach(x => { if (x.preview) URL.revokeObjectURL(x.preview); }); setItems([]); };
  const busy = items.some(x => !x.id && !x.error);
  const ids = items.filter(x => x.id).map(x => x.id!);
  // A failed upload stays shown (with its error) until removed, but is not sent.
  return { items, add, remove, sent, busy, ids };
}

function FileChip({ name, size }: { name: string; size?: number }) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot + 1).toUpperCase() : '';
  return (
    <span className="file-chip">
      <Ic i={FileText} size={18} />
      <span className="file-chip-text"><span className="file-chip-name">{name}</span><span className="file-chip-meta num">{[ext, size != null ? fmtBytes(size) : ''].filter(Boolean).join(' · ')}</span></span>
    </span>
  );
}

/** A sent message's files: images as thumbnails (open full size), other files as chips that download. */
function MessageAttachments({ message }: { message: ChatMessage }) {
  const list = (message.meta?.attachments ?? message.meta?.images) as { id: string; name: string; kind?: string; size?: number }[] | undefined;
  if (!list?.length) return null;
  const url = (id: string, download = false) => `/api/messages/${message.id}/attachments/${id}?token=${encodeURIComponent(token)}${download ? '&download=1' : ''}`;
  return (
    <div className="chat-images">{list.map(x => (x.kind ?? 'image') === 'image'
      ? <a key={x.id} href={url(x.id)} target="_blank" rel="noreferrer" title={x.name}><img src={url(x.id)} alt={x.name} /></a>
      : <a key={x.id} className="chat-file" href={url(x.id, true)} download={x.name} title={`Download ${x.name}`}><FileChip name={x.name} size={x.size} /><Ic i={Download} size={14} /></a>)}
    </div>
  );
}

// ---------------------------------------------------------------- sub-agent


/** First line of a text, cut to a short summary. */
const brief = (s: string, n = 140) => { const l = plain(s).trim().split('\n').find(x => x.trim())?.trim() ?? ''; return l.length > n ? `${l.slice(0, n - 1)}…` : l; };

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

type Origin = { title: string; open: () => void } | null;

const FromChat = ({ origin }: { origin: Origin }) => origin && (
  <span><button className="link-btn" title="Open the chat this came from" onClick={origin.open}>From chat: {origin.title}</button></span>
);

/** Work the coordinator did itself: its commit message and the files it changed. There is no agent run to show. */
function CoordinatorRecord({ task, origin }: { task: Task; origin: Origin }) {
  const body = task.description.split(/\r?\n/).slice(1).join('\n').trim();
  return (
    <div className="chat agent">
      <header className="agent-head">
        <div className="agent-title"><Dot state={task.status} /><span className="num">T{task.seq}</span><span className="agent-name" title={task.title}>{task.title}</span></div>
        <div className="agent-meta">
          <span>Coordinator edit</span><span>{timeAgo(task.updatedAt)}</span><FromChat origin={origin} />
        </div>
      </header>
      <div className="stream record">
        {body && <Markdown className="record-body" text={body} />}
        {task.result?.summary && <Markdown className="record-sum" text={task.result.summary} />}
        <ul className="record-files mono">{task.paths.map(f => <li key={f}>{f}</li>)}</ul>
      </div>
    </div>
  );
}

function AgentChat({ task, origin, info, accounts, logTick, onError, reload }: { task: Task; origin: Origin; info: TaskModelInfo | undefined; accounts: Account[]; logTick: number; onError: (e: string) => void; reload: () => void }) {
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

  const follow = useFollow(`${runs?.length}:${runs?.at(-1)?.turns.reduce((n, x) => n + x.events.length, 0)}`, task.id);
  const act = (a: string) => api('POST', `/api/tasks/${task.id}/${a}`).then(reload).catch(e => onError(e.message));
  // Finished: more work for this same agent (its conversation and worktree). Otherwise: a message for its next run.
  const finished = ['done', 'failed', 'cancelled'].includes(task.status);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    follow.toEnd();
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
  // The checklist: the last one the agent reported, in any run.
  const planText = runs?.flatMap(x => x.turns.flatMap(t => t.events)).filter(e => e.kind === 'plan').at(-1)?.text;
  const plan = planText ? parsePlan(planText) : null;

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
          <FromChat origin={origin} />
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
                {(() => {
                  // The agent's words in full; everything it ran between them folds into one grey line.
                  const items = groupEvents(x.events);
                  const lastTurn = ri === runs.length - 1 && ti === run.turns.length - 1 && !run.endedAt;
                  let named = false;
                  return items.map((it, i) => {
                    if (it.type === 'group') return <ToolGroup key={i} lines={it.lines} live={isRunning && lastTurn && i === items.length - 1} />;
                    const head = !named; named = true;
                    return (
                      <div key={i} className="msg m-agent">
                        {head && <div className="msg-head"><span className="msg-who">{label(task.role)}</span></div>}
                        <Markdown className="msg-text" text={it.e.text} />
                      </div>
                    );
                  });
                })()}
              </div>
            ))}
            {run.endedAt && <RunEnd run={run} />}
          </div>
        ))}
        {isRunning && <div className="typing live" aria-label="Working"><span /><span /><span /></div>}
        <JumpToEnd follow={follow} />
      </div>

      {(report || plan) && (
        <div className="agent-dock">
          {plan && <PlanCard items={plan} live={isRunning} />}
          {report && <details className={`fold fold-${report.kind}`}>
            <summary><Ic i={ChevronRight} size={14} /><span className="fold-label">{report.label}</span><span className="fold-sum">{report.short}</span></summary>
            <div className="fold-body">
              {failedNow ? <pre className="pre">{task.error}</pre> : <Markdown className="msg-text" text={r!.summary} />}
              {failedNow && lastRun?.reason && lastRun.reason !== task.error && <div className="fold-line">Run: {lastRun.reason}</div>}
              {!failedNow && r!.issues.length > 0 && <><div className="io-label">Open issues</div><ul className="fold-list">{r!.issues.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
              {!failedNow && failing.length > 0 && <><div className="io-label">Criteria not met</div><ul className="fold-list">{failing.map(c => <li key={c.id}><span className="num">{c.id}</span> {c.pass === 'blocked' ? 'cannot be checked here' : 'fails'}: {c.evidence}</li>)}</ul></>}
              {!failedNow && r!.review && <div className="review"><b>Review: {r!.review.verdict.replace('_', ' ')}</b>{r!.review.comments.map((c, i) => <Markdown key={i} text={c} />)}</div>}
              {(task.branch || task.paths.length > 0) && <div className="fold-line mono">{[task.branch, ...task.paths].filter(Boolean).join('  ')}</div>}
            </div>
          </details>}
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

/** The end of a run as one grey line (how it ended, how long, tokens), opening to the account, model and where the time went. */
function RunEnd({ run }: { run: RunTurns }) {
  const [open, setOpen] = useState(false);
  const ok = run.outcome === 'success';
  const ms = run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : 0;
  const head = [ok ? 'Run finished' : `Run ${label(run.outcome ?? 'ended').toLowerCase()}`, ms > 0 ? dur(ms) : '', run.usage ? `${fmtTokens(run.usage.total)} tokens` : ''].filter(Boolean).join(' · ');
  return (
    <div className={`tgroup run-fold ${open ? 'open' : ''} ${ok ? '' : 'bad'}`}>
      <button className="tgroup-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="tgroup-sum num">{head}</span>
        <Ic i={ChevronRight} size={14} />
      </button>
      {!ok && run.reason && !open && <div className="tgroup-now">{brief(run.reason)}</div>}
      {open && (
        <div className="run-fold-body">
          <div className="evt k-status"><span className="evt-kind">run</span><span className="evt-text">{[run.outcome ?? 'ended', run.accountId, run.model, run.effort, run.outcome !== 'success' ? run.reason : ''].filter(Boolean).join(' · ')}</span></div>
          {run.timing && <RunTimeBar t={run.timing} />}
        </div>
      )}
    </div>
  );
}

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
