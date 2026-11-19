import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, RotateCcw, Square, X } from 'lucide-react';
import { api, clock } from '../api.ts';
import type { ProjectDetail, Swarm } from '../store.ts';
import type { Account, ChatMessage, Project, Task } from '../types.ts';
import { Dot, Ic, label } from '../ui.tsx';
import { COORDINATOR } from '../network/layout.ts';

interface Props {
  s: Swarm;
  detail: ProjectDetail;
  tabs: string[];
  active: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onHide: () => void;
}

export function ChatPanel({ s, detail, tabs, active, onActivate, onClose, onHide }: Props) {
  const byId = new Map(detail.tasks.map(t => [t.id, t]));
  return (
    <aside className="chat-panel">
      <div className="chat-tabs" role="tablist">
        <button role="tab" aria-selected={active === COORDINATOR} className={`ctab ${active === COORDINATOR ? 'active' : ''}`} onClick={() => onActivate(COORDINATOR)}>
          <Dot state={s.thinking ? 'running' : 'idle'} /><span>Coordinator</span>
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
      {active === COORDINATOR || !byId.has(active)
        ? <CoordinatorChat project={detail.project} messages={s.messages} thinking={s.thinking} onError={s.setError} />
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

const AUTHOR: Record<ChatMessage['author'], string> = { user: 'You', coordinator: 'Coordinator', agent: 'Agent', system: 'Swarm' };

function CoordinatorChat({ project, messages, thinking, onError }: { project: Project; messages: ChatMessage[]; thinking: string | null; onError: (e: string) => void }) {
  const [text, setText] = useState('');
  const follow = useFollow(`${messages.length}:${thinking}`);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    await api('POST', `/api/projects/${project.id}/messages`, { text: t }).catch(e => onError(e.message));
  };
  const decide = (id: number, approve: boolean) => api('POST', `/api/messages/${id}/proposal`, { approve }).catch(e => onError(e.message));
  return (
    <div className="chat">
      <div className="stream" ref={follow.ref} onScroll={follow.onScroll}>
        {!messages.length && <div className="stream-empty">Ask the coordinator about progress, or give the swarm a direction</div>}
        {messages.map(m => {
          const prop = m.meta?.proposal as any;
          const level = (m.meta?.level as string) ?? '';
          return (
            <div key={m.id} className={`msg m-${m.author} ${level}`}>
              <div className="msg-head"><span className="msg-who">{AUTHOR[m.author]}</span><span className="msg-meta num">{clock(m.createdAt)}{m.meta?.account ? ` · ${m.meta.account}` : ''}</span></div>
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
        <textarea value={text} rows={3} placeholder="Message the coordinator" onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <div className="composer-bar">
          <span className="hint"><kbd>Enter</kbd> send · <kbd>Shift</kbd> <kbd>Enter</kbd> new line</span>
          <button className="primary icon-send" disabled={!text.trim()} onClick={send} title="Send"><Ic i={ArrowUp} /></button>
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
      <div className="agent-foot">Read only · steer the swarm from the Coordinator tab</div>
    </div>
  );
}
