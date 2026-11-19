import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronRight, Pencil, Plus, RotateCcw, Square, Trash2, X } from 'lucide-react';
import { api, clock } from '../api.ts';
import type { ProjectDetail, Plexus } from '../store.ts';
import type { Account, ChatMessage, ChatSession, Project, Provider, Role, Task } from '../types.ts';
import { Dot, Ic, label } from '../ui.tsx';
import { COORDINATOR } from '../network/layout.ts';
import { EffortSelect, ModelDatalist, useModels } from '../models.tsx';

interface Props {
  s: Plexus;
  detail: ProjectDetail;
  /** The chat panel is on screen (not hidden): unread marks of the open session are cleared while it is. */
  visible: boolean;
  tabs: string[];
  active: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onHide: () => void;
}

export function ChatPanel({ s, detail, visible, tabs, active, onActivate, onClose, onHide }: Props) {
  const byId = new Map(detail.tasks.map(t => [t.id, t]));
  const onCoordinator = active === COORDINATOR || !byId.has(active);
  const current = s.sessions.find(x => x.id === s.sessionId);
  const unreadTotal = s.sessions.reduce((n, x) => n + x.unread, 0);
  // Looking at a session counts as reading it: system/agent notices that arrive meanwhile are acknowledged right away.
  const viewing = visible && onCoordinator;
  useEffect(() => {
    if (viewing && current && current.unread > 0) api('POST', `/api/chat-sessions/${current.id}/read`).then(s.loadSessions).catch(() => {});
  }, [viewing, current?.id, current?.unread]);
  return (
    <aside className="chat-panel">
      <div className="chat-tabs" role="tablist">
        <button role="tab" aria-selected={active === COORDINATOR} className={`ctab ${active === COORDINATOR ? 'active' : ''}`} onClick={() => onActivate(COORDINATOR)}>
          <Dot state={Object.keys(s.thinking).length ? 'running' : 'idle'} /><span>Coordinator</span>{unreadTotal > 0 && !viewing && <span className="unread-dot" title={`${unreadTotal} unread`} />}
        </button>
        {tabs.map(id => {
          const t = byId.get(id);
          if (!t) return null;
          return (
            <div key={id} role="tab" aria-selected={active === id} className={`ctab ${active === id ? 'active' : ''}`} onClick={() => onActivate(id)} onAuxClick={e => { if (e.button === 1) onClose(id); }} title={t.title}>
              <Dot state={t.status} /><span className="num">T{t.seq}</span><span className="ctab-role">{t.role}</span>
              <button className="ctab-x" title="Close" onClick={e => { e.stopPropagation(); onClose(id); }}><Ic i={X} size={14} /></button>
            </div>
          );
        })}
        <span className="spacer" />
        <button className="icon-btn chat-hide" title="Hide chat" onClick={onHide}><Ic i={X} /></button>
      </div>
      {onCoordinator
        ? <CoordinatorChat project={detail.project} accounts={s.accounts} sessions={s.sessions} sessionId={s.sessionId} onSession={s.setSessionId} loadSessions={s.loadSessions} messages={s.messages} thinking={s.sessionId ? s.thinking[s.sessionId] ?? null : null} thinkingIn={s.thinking} onError={s.setError} reload={s.loadDetail} />
        : <AgentChat key={active} task={byId.get(active)!} accounts={s.accounts} logTick={s.logTick} onError={s.setError} reload={s.loadDetail} />}
    </aside>
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

/** Account and model the coordinator answers with, stored in the project settings. */
function CoordinatorOptions({ project, accounts, onError, reload }: { project: Project; accounts: Account[]; onError: (e: string) => void; reload: () => void }) {
  const [coordRole, setCoordRole] = useState<Role | null>(null);
  useEffect(() => { api<Role[]>('GET', '/api/roles').then(r => setCoordRole(r.find(x => x.name === 'coordinator') ?? null)).catch(() => {}); }, []);
  const roleModels = coordRole?.models ?? {}, roleEfforts = coordRole?.efforts ?? {};
  const catalog = useModels();
  const saved = project.settings.coordinatorModels ?? {};
  const savedEfforts = project.settings.coordinatorEfforts ?? {};
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => setDraft({}), [project.id, JSON.stringify(saved)]);

  const pinnedId = project.settings.coordinatorAccountId ?? null;
  const pinned = pinnedId ? accounts.find(a => a.id === pinnedId) : undefined;
  const providers: Provider[] = pinned ? [pinned.provider] : [...new Set(accounts.filter(a => a.enabled).map(a => a.provider))];

  const save = (settings: Partial<Project['settings']>) =>
    api('PATCH', `/api/projects/${project.id}`, { settings }).then(reload).catch(e => onError(e.message));
  const commitModel = (p: Provider) => {
    if (!(p in draft)) return;
    const v = draft[p].trim();
    if (v === (saved[p] ?? '')) return;
    void save({ coordinatorModels: { ...saved, [p]: v || undefined } });
  };

  return (
    <div className="coord-opts">
      <select value={pinnedId ?? ''} title="Account the coordinator answers with" onChange={e => void save({ coordinatorAccountId: e.target.value || null })}>
        <option value="">Account: automatic</option>
        {pinnedId && !pinned && <option value={pinnedId}>{pinnedId} (missing)</option>}
        {accounts.map(a => <option key={a.id} value={a.id}>{a.label || a.id} · {PROVIDER_NAME[a.provider]}{a.enabled ? (a.state === 'ok' || a.state === 'unknown' ? '' : ` · ${label(a.state)}`) : ' · disabled'}</option>)}
      </select>
      {providers.map(p => (
        <label key={p} className="coord-model" title={`Model the coordinator uses on ${PROVIDER_NAME[p]} accounts; empty uses the coordinator role default`}>
          {!pinned && <span>{PROVIDER_NAME[p]}</span>}
          <input list={`coord-models-${p}`} value={draft[p] ?? saved[p] ?? ''} placeholder={roleModels[p] ? `${roleModels[p]} (default)` : 'CLI default'}
            onChange={e => setDraft({ ...draft, [p]: e.target.value })} onBlur={() => commitModel(p)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') { setDraft({}); } }} />
          <ModelDatalist id={`coord-models-${p}`} provider={p} catalog={catalog} />
          <EffortSelect catalog={catalog} provider={p} model={(draft[p] ?? saved[p]) || roleModels[p]} value={savedEfforts[p] ?? ''}
            fallbackLabel={roleEfforts[p] ? `Effort: ${roleEfforts[p]} (default)` : undefined}
            title={`Reasoning effort the coordinator uses on ${PROVIDER_NAME[p]} accounts`}
            onChange={v => void save({ coordinatorEfforts: { ...savedEfforts, [p]: v || undefined } })} />
        </label>
      ))}
    </div>
  );
}

interface SessionProps { sessions: ChatSession[]; sessionId: string | null; onSession: (id: string) => void; loadSessions: () => void }

/** Chat sessions of the project: one chip each, a red dot where system/agent notices wait to be read. */
function SessionBar({ project, sessions, sessionId, onSession, loadSessions, thinkingIn, onError }: SessionProps & { project: Project; thinkingIn: Record<string, string>; onError: (e: string) => void }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const done = () => { setRenaming(null); setDeleting(null); };
  const create = () => api<ChatSession>('POST', `/api/projects/${project.id}/chat-sessions`, {}).then(c => { loadSessions(); onSession(c.id); }).catch(e => onError(e.message));
  const rename = (id: string) => {
    const t = name.trim();
    done();
    if (t) api('PATCH', `/api/chat-sessions/${id}`, { title: t }).then(loadSessions).catch(e => onError(e.message));
  };
  const remove = (id: string) => {
    done();
    api('DELETE', `/api/chat-sessions/${id}`).then(loadSessions).catch(e => onError(e.message));
  };
  return (
    <div className="sessions" role="tablist" aria-label="Chats">
      {sessions.map(x => {
        const on = x.id === sessionId;
        return (
          <div key={x.id} role="tab" aria-selected={on} className={`schip ${on ? 'active' : ''}`} onClick={() => { if (!on) { done(); onSession(x.id); } }}
            onDoubleClick={() => { setRenaming(x.id); setName(x.title); }} title={x.title || 'New chat'}>
            {renaming === x.id
              ? <input autoFocus value={name} onChange={e => setName(e.target.value)} onClick={e => e.stopPropagation()} onBlur={() => rename(x.id)}
                  onKeyDown={e => { if (e.key === 'Enter') rename(x.id); if (e.key === 'Escape') done(); }} />
              : <span className="schip-title">{x.title || 'New chat'}</span>}
            {thinkingIn[x.id] && <span className="typing live" title="Coordinator is answering"><span /><span /><span /></span>}
            {x.unread > 0 && !on && <span className="unread-dot" title={`${x.unread} unread`}>{x.unread > 9 ? '9+' : x.unread}</span>}
            {on && renaming !== x.id && deleting !== x.id && (
              <>
                <button className="schip-btn" title="Rename (double-click)" onClick={e => { e.stopPropagation(); setRenaming(x.id); setName(x.title); }}><Ic i={Pencil} size={12} /></button>
                {sessions.length > 1 && <button className="schip-btn" title="Delete chat" onClick={e => { e.stopPropagation(); setDeleting(x.id); }}><Ic i={Trash2} size={12} /></button>}
              </>
            )}
            {deleting === x.id && (
              <>
                <span className="schip-ask">Delete?</span>
                <button className="schip-btn danger" title="Delete this chat and its messages" onClick={e => { e.stopPropagation(); remove(x.id); }}><Ic i={Check} size={12} /></button>
                <button className="schip-btn" title="Keep" onClick={e => { e.stopPropagation(); setDeleting(null); }}><Ic i={X} size={12} /></button>
              </>
            )}
          </div>
        );
      })}
      <button className="schip-new" title="New chat" onClick={create}><Ic i={Plus} size={14} /></button>
    </div>
  );
}

function CoordinatorChat({ project, accounts, sessions, sessionId, onSession, loadSessions, messages, thinking, thinkingIn, onError, reload }: SessionProps & { project: Project; accounts: Account[]; messages: ChatMessage[]; thinking: string | null; thinkingIn: Record<string, string>; onError: (e: string) => void; reload: () => void }) {
  const [text, setText] = useState('');
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
      <SessionBar project={project} sessions={sessions} sessionId={sessionId} onSession={onSession} loadSessions={loadSessions} thinkingIn={thinkingIn} onError={onError} />
      <div className="stream" ref={follow.ref} onScroll={follow.onScroll}>
        {!messages.length && <div className="stream-empty">Ask the coordinator about progress, or give Plexus a direction</div>}
        {messages.map(m => {
          const prop = m.meta?.proposal as any;
          const level = (m.meta?.level as string) ?? '';
          return (
            <div key={m.id} className={`msg m-${m.author} ${level}`}>
              <div className="msg-head"><span className="msg-who">{AUTHOR[m.author]}</span><span className="msg-meta num">{clock(m.createdAt)}{m.meta?.account ? ` · ${m.meta.account}` : ''}{m.meta?.model ? ` · ${m.meta.model}` : ''}</span></div>
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
        <CoordinatorOptions project={project} accounts={accounts} onError={onError} reload={reload} />
        <textarea value={text} rows={3} placeholder="Message the coordinator" onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <div className="composer-bar">
          <span className="hint"><kbd>Enter</kbd> send · <kbd>Shift</kbd> <kbd>Enter</kbd> new line</span>
          <button className="primary icon-send" disabled={!text.trim() || !sessionId} onClick={send} title="Send"><Ic i={ArrowUp} /></button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sub-agent

interface RunRow { id: number; accountId: string; startedAt: string; endedAt: string | null; outcome: string | null; classification?: { reason?: string } }
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
  const shown = runs.find(r => r.id === (run ?? data?.run?.id));
  const acct = accounts.find(a => a.id === (shown?.accountId ?? task.accountId ?? task.lastAccountId));

  return (
    <div className="chat agent">
      <header className="agent-head">
        <div className="agent-title"><Dot state={task.status} /><span className="num">T{task.seq}</span><span className="agent-name">{task.title}</span></div>
        <div className="agent-meta">
          <span>{task.role}</span><span>{label(task.status)}</span>
          {acct && <span>{acct.label}</span>}
          {task.attempts > 0 && <span className="num">attempt {task.attempts}</span>}
          {task.branch && <span className="mono">{task.branch}</span>}
        </div>
        {task.paths.length > 0 && <div className="agent-paths mono" title="Files this task expects to change">{task.paths.join('  ')}</div>}
        <div className="agent-actions">
          {runs.length > 1 && (
            <select value={run ?? ''} onChange={e => setRun(e.target.value ? Number(e.target.value) : null)} title="Run">
              <option value="">Latest run</option>
              {runs.map((r, i) => <option key={r.id} value={r.id}>Run {i + 1} · {r.accountId} · {r.outcome ?? 'running'}</option>)}
            </select>
          )}
          <span className="spacer" />
          {['failed', 'cancelled', 'interrupted'].includes(task.status) && <button onClick={() => act('retry')}><Ic i={RotateCcw} />Retry</button>}
          {!['done', 'cancelled'].includes(task.status) && <button className="danger" onClick={() => act('cancel')}><Ic i={Square} />Cancel</button>}
        </div>
      </header>

      <div className="stream" ref={follow.ref} onScroll={follow.onScroll}>
        <details className="io">
          <summary><Ic i={ChevronRight} size={14} />Input<span className="io-meta">{data?.prompt ? `${Math.round(data.prompt.length / 1000)}k chars sent to the agent` : 'task description'}</span></summary>
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

        {task.result && (
          <div className="result">
            <div className="io-label">Result · {task.result.status}</div>
            <div className="msg-text">{task.result.summary}</div>
            {task.result.review && <div className="review"><b>Review: {task.result.review.verdict.replace('_', ' ')}</b>{task.result.review.comments.map((c, i) => <div key={i}>{c}</div>)}</div>}
          </div>
        )}
        {task.error && task.status !== 'done' && <div className="result err"><div className="io-label">Last error</div><pre className="pre">{task.error}</pre></div>}
        {shown?.classification?.reason && <div className="evt k-status"><span className="evt-kind">run</span><span className="evt-text">{shown.classification.reason}</span></div>}
      </div>
      <div className="agent-foot">Read only · steer Plexus from the Coordinator tab</div>
    </div>
  );
}
