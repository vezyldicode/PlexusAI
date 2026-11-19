import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, Plus, X } from 'lucide-react';
import { useSwarm } from './store.ts';
import { Sidebar, type Page } from './components/Sidebar.tsx';
import { ChatPanel } from './components/ChatPanel.tsx';
import { NetworkView } from './network/NetworkView.tsx';
import { COORDINATOR } from './network/layout.ts';
import { ActivityView, MemoryView, ProjectHeader, ReportView, StatusView, TasksView, VIEWS, type View } from './views.tsx';
import { AccountsPage, NewProjectDialog, RolesPage, SkillsPage } from './pages.tsx';
import { Empty, Ic } from './ui.tsx';

const MAX_TABS = 8;
const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export default function App() {
  const [page, setPage] = useState<Page>('project');
  const [selected, setSelected] = useState<string | null>(() => stored('swarm.project'));
  const [view, setView] = useState<View>(() => (VIEWS as string[]).includes(stored('swarm.view') ?? '') ? stored('swarm.view') as View : 'network');
  const [showNew, setShowNew] = useState(false);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string>(COORDINATOR);
  const [chatOpen, setChatOpen] = useState(() => innerWidth > 1180);
  const s = useSwarm(selected);

  useEffect(() => { if (selected) store('swarm.project', selected); setTabs([]); setActive(COORDINATOR); }, [selected]);
  useEffect(() => { store('swarm.view', view); }, [view]);
  useEffect(() => {
    if (!selected && s.projects.length) setSelected(s.projects[0].id);
    if (selected && s.projects.length && !s.projects.some(p => p.id === selected)) setSelected(s.projects[0]?.id ?? null);
  }, [s.projects, selected]);

  /** Open (or focus) the chat tab for an agent. Clicking a node on the network lands here. */
  const open = useCallback((id: string) => {
    setChatOpen(true);
    setActive(id);
    if (id === COORDINATOR) return;
    setTabs(ts => (ts.includes(id) ? ts : [...ts, id].slice(-MAX_TABS)));
  }, []);
  const close = useCallback((id: string) => {
    setTabs(ts => {
      const i = ts.indexOf(id);
      const next = ts.filter(x => x !== id);
      setActive(a => (a === id ? next[Math.max(0, i - 1)] ?? COORDINATOR : a));
      return next;
    });
  }, []);

  const d = s.detail;
  const showChat = page === 'project' && !!d;
  return (
    <div className={`app ${showChat ? 'with-chat' : ''} ${showChat && chatOpen ? 'chat-open' : ''}`}>
      <Sidebar projects={s.projects} accounts={s.accounts} connected={s.connected} page={page} selected={selected}
        onProject={id => { setSelected(id); setPage('project'); }} onPage={setPage} onNew={() => setShowNew(true)}
        reloadAccounts={s.loadAccounts} onError={s.setError} />

      <main className="main">
        {s.error && <div className="banner error" role="alert"><span>{s.error}</span><button className="icon-btn" onClick={() => s.setError(null)} title="Dismiss"><Ic i={X} /></button></div>}
        {page === 'project' && (d ? (
          <div className="project">
            <ProjectHeader s={s} detail={d} view={view} onView={setView} />
            <button className="chat-toggle" onClick={() => setChatOpen(o => !o)} title="Toggle chat"><Ic i={MessageSquare} /></button>
            <div className="view-body">
              {view === 'network' && <NetworkView detail={d} accounts={s.accounts} lastLine={s.lastLine} thinking={s.thinking} active={active} onOpen={open} onError={s.setError} reload={s.loadDetail} />}
              {view === 'tasks' && <TasksView detail={d} active={active} onOpen={open} />}
              {view === 'activity' && <ActivityView logs={s.logs} activity={s.activity} detail={d} onOpen={open} />}
              {view === 'memory' && <MemoryView project={d.project} onError={s.setError} />}
              {view === 'report' && <ReportView project={d.project} />}
              {view === 'status' && <StatusView detail={d} />}
            </div>
          </div>
        ) : (
          <Empty title="No project selected">
            <p>Create a project from a folder that holds your documentation, then start the swarm.</p>
            <button className="primary" onClick={() => setShowNew(true)}><Ic i={Plus} />New project</button>
          </Empty>
        ))}
        {page === 'accounts' && <AccountsPage accounts={s.accounts} reload={s.loadAccounts} onError={s.setError} />}
        {page === 'roles' && <RolesPage onError={s.setError} />}
        {page === 'skills' && <SkillsPage onError={s.setError} />}
      </main>

      {showChat && <ChatPanel s={s} detail={d!} tabs={tabs} active={active} onActivate={setActive} onClose={close} onHide={() => setChatOpen(false)} />}
      {showNew && <NewProjectDialog onClose={() => setShowNew(false)} onCreated={id => { setShowNew(false); setSelected(id); setPage('project'); s.loadProjects(); }} onError={s.setError} />}
    </div>
  );
}
