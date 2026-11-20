import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pause, Play, Square } from 'lucide-react';
import { api, clock, timeAgo } from './api.ts';
import type { LogLine, ProjectDetail, Plexus } from './store.ts';
import type { Project, Role, Task } from './types.ts';
import { Dot, Ic, label, Tokens, UsageBreakdown, fmtTokens, usageTitle } from './ui.tsx';

export type View = 'network' | 'tasks' | 'activity' | 'memory' | 'report' | 'status';
export const VIEWS: View[] = ['network', 'tasks', 'activity', 'memory', 'report', 'status'];

// ---------------------------------------------------------------- header

export function ProjectHeader({ s, detail, view, onView, trailing }: { s: Plexus; detail: ProjectDetail; view: View; onView: (v: View) => void; trailing?: ReactNode }) {
  const p = detail.project;
  const act = (a: string) => api('POST', `/api/projects/${p.id}/${a}`, { sessionId: s.sessionId }).then(() => { s.loadDetail(); s.loadProjects(); }).catch(e => s.setError(e.message));
  const running = detail.tasks.filter(t => t.status === 'running').length;
  const acc = detail.acceptance;
  const passed = acc.filter(a => a.pass).length;
  return (
    <header className="phead">
      <div className="phead-row">
        <div className="phead-id">
          <h1>{p.name}</h1>
          <div className="phead-meta"><span className="mono" title={p.path}>{p.path}</span><span>branch <span className="mono">{p.mainBranch}</span></span></div>
        </div>
        <div className="phead-state">
          {detail.waiting && p.status === 'running'
            ? <span className="state waiting" title={`${detail.waiting.tasks} task(s) ready, no account with quota left. Plexus continues on its own when one is available.`}><Dot state="limited" /><span className="num">{detail.waiting.nextReset ? `Waiting for quota · reset ${timeAgo(detail.waiting.nextReset)}` : 'Waiting for quota'}</span></span>
            : <span className="state"><Dot state={p.status} />{label(p.status)}</span>}
          <span className="state-meta">{p.phase}</span>
          {running > 0 && <span className="state-meta num">{running} running</span>}
          {acc.length > 0 && <span className="state-meta num" title="Acceptance criteria passed">{passed}/{acc.length} criteria</span>}
        </div>
        <div className="phead-actions">
          {p.status === 'idle' && <button className="primary" onClick={() => act('start')}><Ic i={Play} />Start</button>}
          {(p.status === 'paused' || p.status === 'stopped' || p.status === 'completed') && <button className="primary" onClick={() => act('resume')}><Ic i={Play} />Resume</button>}
          {p.status === 'running' && <button onClick={() => act('pause')}><Ic i={Pause} />Pause</button>}
          {(p.status === 'running' || p.status === 'paused') && <button className="danger" onClick={() => act('stop')}><Ic i={Square} />Stop</button>}
          {trailing}
        </div>
      </div>
      <nav className="views" role="tablist">
        {VIEWS.map(v => (
          <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => onView(v)}>
            {label(v)}{v === 'tasks' && <span className="view-count num">{detail.tasks.length}</span>}
          </button>
        ))}
      </nav>
    </header>
  );
}

// ---------------------------------------------------------------- tasks

const COLUMNS: { title: string; statuses: Task['status'][] }[] = [
  { title: 'Queued', statuses: ['pending', 'interrupted'] },
  { title: 'Running', statuses: ['running'] },
  { title: 'In review', statuses: ['in_review'] },
  { title: 'Done', statuses: ['done'] },
  { title: 'Failed or cancelled', statuses: ['failed', 'cancelled'] },
];

export function TasksView({ detail, active, onOpen }: { detail: ProjectDetail; active: string; onOpen: (id: string) => void }) {
  const bySeq = useMemo(() => new Map(detail.tasks.map(t => [t.id, t.seq])), [detail.tasks]);
  return (
    <div className="board">
      {COLUMNS.map(c => {
        const list = detail.tasks.filter(t => c.statuses.includes(t.status)).sort((a, b) => (c.title === 'Done' ? b.seq - a.seq : b.priority - a.priority || a.seq - b.seq));
        return (
          <section key={c.title} className="col">
            <div className="col-title">{c.title}<span className="num">{list.length}</span></div>
            {list.map(t => (
              <button key={t.id} className={`card s-${t.status} ${active === t.id ? 'sel' : ''}`} onClick={() => onOpen(t.id)}>
                <div className="card-top"><Dot state={t.status} /><span className="num">T{t.seq}</span><span className="card-role">{t.role}</span><Tokens u={detail.usage.tasks[t.id]} className="card-tok" /></div>
                <div className="card-title">{t.title}</div>
                <div className="card-meta">
                  {t.accountId ? t.accountId : t.lastAccountId ? `last ${t.lastAccountId}` : ''}
                  {t.attempts > 0 ? ` · attempt ${t.attempts}` : ''}
                  {t.deps.length ? ` · after ${t.deps.map(d => 'T' + bySeq.get(d)).join(', ')}` : ''}
                </div>
                {t.error && t.status !== 'done' && <div className="card-err">{t.error.slice(0, 140)}</div>}
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- activity

export function ActivityView({ logs, activity, detail, onOpen }: { logs: LogLine[]; activity: Plexus['activity']; detail: ProjectDetail; onOpen: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [agent, setAgent] = useState('');
  const shown = agent ? logs.filter(l => l.taskId === agent) : logs;
  useEffect(() => { if (follow) ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [shown.length, follow]);
  const seen = [...new Map(logs.map(l => [l.taskId, l.taskSeq])).entries()];
  const describe = (e: any) => {
    const d = e.data ?? {};
    switch (e.type) {
      case 'task.created': return `Created T${d.seq} (${d.role}) ${d.title}`;
      case 'task.started': return `T${d.seq} started on ${d.account}, attempt ${d.attempt}`;
      case 'task.updated': return `T${d.seq} is ${String(d.status).replace('_', ' ')}${d.error ? `: ${String(d.error).slice(0, 120)}` : ''}`;
      case 'task.result': return `T${d.seq} result ${d.status}: ${String(d.summary).slice(0, 160)}`;
      case 'task.merged': return `T${d.seq} merged from ${d.branch}`;
      case 'account.updated': return `${d.id} is ${d.state}${d.stateReason ? `: ${d.stateReason}` : ''}`;
      default: return `${e.type} ${JSON.stringify(d).slice(0, 160)}`;
    }
  };
  const taskId = (e: any) => (e.type.startsWith('task.') && e.data?.id ? e.data.id : null);
  return (
    <div className="activity">
      <section className="panel live">
        <div className="panel-head">
          <span>Agent output</span>
          <select value={agent} onChange={e => setAgent(e.target.value)}>
            <option value="">All agents</option>
            {seen.map(([id, seq]) => <option key={id} value={id}>T{seq} {detail.tasks.find(t => t.id === id)?.role ?? ''}</option>)}
          </select>
          <span className="spacer" />
          <label className="check"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />Follow</label>
        </div>
        <div className="loglines" ref={ref}>
          {shown.map((l, i) => (
            <div key={i} className={`logline k-${l.kind}`}>
              <span className="ll-time num">{l.at.slice(11, 19)}</span>
              <button className="ll-task num" onClick={() => onOpen(l.taskId)}>T{l.taskSeq}</button>
              <span className="ll-acct">{l.account}</span>
              <span className="ll-text">{l.text}</span>
            </div>
          ))}
          {!shown.length && <div className="stream-empty">Agent output appears here while tasks run</div>}
        </div>
      </section>
      <section className="panel events">
        <div className="panel-head"><span>Events</span></div>
        <div className="event-list">
          {[...activity].reverse().map(e => {
            const id = taskId(e);
            return (
              <div key={e.id + e.type + e.createdAt} className={`event ${id ? 'linked' : ''}`} onClick={() => id && onOpen(id)}>
                <span className="ev-time num">{clock(e.createdAt)}</span><span>{describe(e)}</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- memory

const MEMORY_FILES = ['goal.md', 'summary.md', 'brief.md', 'acceptance.md', 'decisions.md', 'directives.md', 'known-issues.md', 'planning-notes.md'];

export function MemoryView({ project, onError }: { project: Project; onError: (e: string) => void }) {
  const [files, setFiles] = useState<Record<string, string>>({});
  const [cur, setCur] = useState('goal.md');
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const load = () => api('GET', `/api/projects/${project.id}/memory`).then(f => { setFiles(f); if (!dirty) setDraft(f[cur] ?? ''); });
  useEffect(() => { void load(); }, [project.id]);
  useEffect(() => { setDraft(files[cur] ?? ''); setDirty(false); }, [cur]);
  const save = () => api('PUT', `/api/projects/${project.id}/memory/${cur}`, { content: draft }).then(() => { setDirty(false); void load(); }).catch(e => onError(e.message));
  return (
    <div className="memory">
      <div className="memfiles">
        {MEMORY_FILES.map(f => (
          <button key={f} className={`nav-row ${cur === f ? 'active' : ''}`} onClick={() => setCur(f)}>
            <span className="nav-text mono">{f}</span>{!files[f]?.trim() && <span className="nav-meta">empty</span>}
          </button>
        ))}
        <p className="memnote">Shared memory every agent reads. Editing it steers Plexus, for example by adding a directive.</p>
      </div>
      <div className="memedit">
        <textarea value={draft} onChange={e => { setDraft(e.target.value); setDirty(true); }} spellCheck={false} />
        <div className="row"><button className="primary" disabled={!dirty} onClick={save}>Save</button><button onClick={() => { setDraft(files[cur] ?? ''); setDirty(false); }} disabled={!dirty}>Revert</button></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- report

export function ReportView({ project }: { project: Project }) {
  const [r, setR] = useState('');
  useEffect(() => { api('GET', `/api/projects/${project.id}/report`).then(d => setR(d.report)); }, [project.id, project.status]);
  return <div className="report">{r ? <pre className="pre prose">{r}</pre> : <div className="stream-empty">The final report appears here when Plexus finishes</div>}</div>;
}

// ---------------------------------------------------------------- status

/** Issue #2: how many agents of each role run now, against the role's limit. */
function RoleLoad({ detail }: { detail: ProjectDetail }) {
  const [roles, setRoles] = useState<Role[]>([]);
  useEffect(() => { api<Role[]>('GET', '/api/roles').then(setRoles).catch(() => {}); }, []);
  const used = new Map<string, { running: number; queued: number }>();
  for (const t of detail.tasks) {
    const u = used.get(t.role) ?? { running: 0, queued: 0 };
    if (t.status === 'running') u.running++;
    if (t.status === 'pending' || t.status === 'interrupted') u.queued++;
    used.set(t.role, u);
  }
  const rows = roles.filter(r => used.has(r.name) || r.maxParallel > 0);
  return (
    <section className="panel">
      <div className="panel-head"><span>Agents by role</span><span className="num muted">project limit {detail.project.settings.maxParallel} at once</span></div>
      {rows.map(r => {
        const u = used.get(r.name) ?? { running: 0, queued: 0 };
        const cap = r.maxParallel || detail.project.settings.maxParallel;
        return (
          <div key={r.name} className="role-load">
            <span className="rl-name">{r.name}</span>
            <span className="rl-bar">{Array.from({ length: cap }, (_, i) => <span key={i} className={i < u.running ? 'on' : ''} />)}</span>
            <span className="rl-fig num">{u.running}/{r.maxParallel || '–'}</span>
            <span className="rl-meta num">{u.queued ? `${u.queued} queued` : ''}</span>
          </div>
        );
      })}
      {!rows.length && <div className="stream-empty">No tasks yet</div>}
      <div className="rl-note">Set a limit per role on the Roles page. Code-writing tasks whose files overlap never run at the same time.</div>
    </section>
  );
}

/** Where the project's tokens went: the split by kind, then by role, then the tasks that used the most. */
function TokenPanel({ detail, onOpen }: { detail: ProjectDetail; onOpen: (id: string) => void }) {
  const u = detail.usage;
  const roles = Object.entries(u.byRole).sort((a, b) => b[1].total - a[1].total);
  if (u.coordinator) roles.push(['coordinator chat', u.coordinator]);
  const max = Math.max(1, ...roles.map(([, r]) => r.total));
  const top = detail.tasks.filter(t => u.tasks[t.id]).sort((a, b) => u.tasks[b.id].total - u.tasks[a.id].total).slice(0, 5);
  return (
    <section className="panel">
      <div className="panel-head"><span>Tokens</span><span className="num muted">{fmtTokens(u.total!.total)} in all</span></div>
      <UsageBreakdown u={u.total!} />
      <div className="tok-group">By role</div>
      {roles.map(([name, r]) => (
        <div key={name} className="tok-row" title={usageTitle(r)}>
          <span className="tok-name">{name}</span>
          <span className="tok-track"><span className="tok-fill" style={{ transform: `scaleX(${r.total / max})` }} /></span>
          <span className="tok-fig num">{fmtTokens(r.total)}</span>
        </div>
      ))}
      <div className="tok-group">Most tokens</div>
      {top.map(t => (
        <button key={t.id} className="tok-task" onClick={() => onOpen(t.id)} title={usageTitle(u.tasks[t.id])}>
          <Dot state={t.status} /><span className="num muted">T{t.seq}</span><span className="tok-task-title">{t.title}</span><span className="tok-fig num">{fmtTokens(u.tasks[t.id].total)}</span>
        </button>
      ))}
    </section>
  );
}

export function StatusView({ detail, onOpen }: { detail: ProjectDetail; onOpen: (id: string) => void }) {
  const acc = detail.acceptance;
  const passed = acc.filter(a => a.pass).length;
  const failed = acc.filter(a => a.pass === false).length;
  const c = detail.counts;
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const order = ['running', 'pending', 'interrupted', 'in_review', 'done', 'failed', 'cancelled'];
  const u = detail.usage;
  return (
    <div className="status">
      <section className="stat-row">
        <div className="stat"><div className="stat-label">Acceptance criteria</div><div className="stat-fig num">{passed}<span>/{acc.length}</span></div><div className="stat-sub">{failed ? `${failed} failing` : acc.length ? 'none failing' : 'set after analysis'}</div></div>
        <div className="stat"><div className="stat-label">Tasks</div><div className="stat-fig num">{total}</div><div className="stat-sub num">{c.done ?? 0} done · {c.running ?? 0} running</div></div>
        <div className="stat"><div className="stat-label">Evaluation rounds</div><div className="stat-fig num">{detail.project.evalRounds}<span>/{detail.project.settings.maxEvalRounds}</span></div><div className="stat-sub">phase {detail.project.phase}</div></div>
        <div className="stat" title={u.total ? usageTitle(u.total) : undefined}>
          <div className="stat-label">Tokens</div>
          <div className="stat-fig num">{u.total ? fmtTokens(u.total.total) : '–'}</div>
          <div className="stat-sub num">{u.total ? `${fmtTokens(u.total.output)} output${u.coordinator ? ` · coordinator ${fmtTokens(u.coordinator.total)}` : ''}` : 'counted as agents finish'}</div>
        </div>
      </section>
      <RoleLoad detail={detail} />
      {u.total && <TokenPanel detail={detail} onOpen={onOpen} />}
      <section className="panel">
        <div className="panel-head"><span>Tasks by status</span></div>
        <div className="share">
          {order.filter(k => c[k]).map(k => <span key={k} className={`share-seg d-${k}`} style={{ flexGrow: c[k] }} title={`${label(k)} ${c[k]}`} />)}
        </div>
        <div className="share-legend">{order.filter(k => c[k]).map(k => <span key={k}><Dot state={k} />{label(k)} <span className="num">{c[k]}</span></span>)}</div>
      </section>
      <section className="panel">
        <div className="panel-head"><span>Acceptance criteria</span><span className="num muted">{passed}/{acc.length}</span></div>
        {acc.map(a => (
          <div key={a.id} className="crit" title={a.evidence ?? ''}>
            <Dot state={a.pass ? 'done' : a.pass === false ? 'failed' : 'pending'} />
            <span className="crit-id mono">{a.id}</span><span>{a.criterion}</span>
          </div>
        ))}
        {!acc.length && <div className="stream-empty">The analyst writes the acceptance criteria in the first phase</div>}
      </section>
    </div>
  );
}
