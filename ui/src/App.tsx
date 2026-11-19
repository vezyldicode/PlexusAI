import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, Plus, X } from 'lucide-react';
import { usePlexus } from './store.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { ChatPanel } from './components/ChatPanel.tsx';
import { NetworkView } from './network/NetworkView.tsx';
import { COORDINATOR } from './network/layout.ts';
import { ActivityView, MemoryView, ProjectHeader, ReportView, StatusView, TasksView, VIEWS, type View } from './views.tsx';
import { NewProjectDialog } from './pages.tsx';
import { SettingsDialog, type SettingsTab } from './settings.tsx';
import { Empty, Ic } from './ui.tsx';
import { Resizer, clamp, useMedia, useStored } from './layout.tsx';

const MAX_TABS = 24;
const LEFT = { def: 264, min: 208, max: 400 };
const RIGHT = { def: 400, min: 320, max: 720 };
const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

/**
 * Chat panel visibility:
 * - docked: its own column (wide window, pinned)
 * - auto: hidden; hovering the right edge slides it in, leaving it slides it out
 * - overlay: narrow window; opened with the chat button, drawn over the content
 */
type Peek = false | 'hover' | 'sticky';

export default function App() {
  const [selected, setSelected] = useState<string | null>(() => stored('plexus.project'));
  const [view, setView] = useState<View>(() => (VIEWS as string[]).includes(stored('plexus.view') ?? '') ? stored('plexus.view') as View : 'network');
  const [showNew, setShowNew] = useState(false);
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string>(COORDINATOR);

  const [collapsed, setCollapsed] = useStored('plexus.left.collapsed', false);
  const [leftW, setLeftW] = useStored('plexus.left.width', LEFT.def);
  const [rightW, setRightW] = useStored('plexus.right.width', RIGHT.def);
  const [pinned, setPinned] = useStored('plexus.chat.pinned', true);
  const [peek, setPeek] = useState<Peek>(false);
  const narrow = useMedia('(max-width: 1100px)');
  const tiny = useMedia('(max-width: 760px)');
  /** On tiny windows the sidebar is always the rail; the full one opens over the content. */
  const [tinyOpen, setTinyOpen] = useState(false);
  useEffect(() => { if (!tiny) setTinyOpen(false); }, [tiny]);

  const s = usePlexus(selected);

  useEffect(() => { if (selected) store('plexus.project', selected); setTabs([]); setActive(COORDINATOR); }, [selected]);
  useEffect(() => { store('plexus.view', view); }, [view]);
  useEffect(() => {
    if (!selected && s.projects.length) setSelected(s.projects[0].id);
    if (selected && s.projects.length && !s.projects.some(p => p.id === selected)) setSelected(s.projects[0]?.id ?? null);
  }, [s.projects, selected]);

  const d = s.detail;
  const showChat = !!d;
  const mode: 'docked' | 'auto' | 'overlay' = narrow ? 'overlay' : pinned ? 'docked' : 'auto';
  const chatVisible = showChat && (mode === 'docked' || !!peek);

  /** Open (or focus) the chat for an agent. Clicking a node on the network lands here. */
  const open = useCallback((id: string) => {
    setPeek(p => p || 'hover');
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

  // The collapse button is the focus switch: rail on the left, chat out of the way on the right.
  const collapse = () => { if (tiny) { setTinyOpen(false); return; } setCollapsed(true); setPinned(false); setPeek(false); };
  const expand = () => { if (tiny) { setTinyOpen(true); return; } setCollapsed(false); setPinned(true); setPeek(false); };

  // A hover peek ends a moment after the pointer leaves the panel, so a slip off the edge doesn't close it.
  const leaveTimer = useRef<number>(undefined);
  const hoverIn = () => { clearTimeout(leaveTimer.current); setPeek(p => p || 'hover'); };
  const hoverOut = () => { clearTimeout(leaveTimer.current); leaveTimer.current = window.setTimeout(() => setPeek(p => (p === 'hover' ? false : p)), 280); };
  useEffect(() => {
    if (!peek) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.backdrop, .menu')) setPeek(false); };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [peek]);

  const isRail = tiny ? !tinyOpen : collapsed;
  const lw = clamp(leftW, LEFT.min, LEFT.max);
  const rw = clamp(rightW, RIGHT.min, RIGHT.max);
  const chatToggle = mode !== 'docked' && (
    <button className="icon-btn" onClick={() => setPeek(p => (p ? false : 'sticky'))} title={chatVisible ? 'Hide chat' : 'Show chat'} aria-pressed={chatVisible}><Ic i={MessageSquare} /></button>
  );

  return (
    <div className={`app ${isRail ? 'left-rail' : ''} ${showChat && mode === 'docked' ? 'chat-docked' : ''}`}
      style={{ '--left-w': `${lw}px`, '--right-w': `${rw}px` } as React.CSSProperties}>
      <Sidebar projects={s.projects} accounts={s.accounts} connected={s.connected} selected={selected}
        collapsed={isRail} overlay={tiny && tinyOpen} onCollapse={collapse} onExpand={expand}
        onProject={id => { setSelected(id); setTinyOpen(false); }} onNew={() => setShowNew(true)} onSettings={t => { setSettings(t ?? 'accounts'); setTinyOpen(false); }}
        reloadProjects={s.loadProjects} reloadAccounts={s.loadAccounts} onError={s.setError}
        resizer={!tiny && <Resizer side="right" width={lw} min={LEFT.min} max={LEFT.max} onWidth={setLeftW} onReset={() => setLeftW(LEFT.def)} label="Resize sidebar" />} />
      {tiny && tinyOpen && <div className="scrim" onClick={() => setTinyOpen(false)} />}

      <main className="main">
        {s.error && <div className="banner error" role="alert"><span>{s.error}</span><button className="icon-btn" onClick={() => s.setError(null)} title="Dismiss"><Ic i={X} /></button></div>}
        {d ? (
          <div className="project">
            <ProjectHeader s={s} detail={d} view={view} onView={setView} trailing={chatToggle} />
            <div className="view-body">
              {view === 'network' && <NetworkView detail={d} accounts={s.accounts} lastLine={s.lastLine} thinking={Object.values(s.thinking)[0] ?? null} active={active} onOpen={open} onError={s.setError} reload={s.loadDetail} />}
              {view === 'tasks' && <TasksView detail={d} active={active} onOpen={open} />}
              {view === 'activity' && <ActivityView logs={s.logs} activity={s.activity} detail={d} onOpen={open} />}
              {view === 'memory' && <MemoryView project={d.project} onError={s.setError} />}
              {view === 'report' && <ReportView project={d.project} />}
              {view === 'status' && <StatusView detail={d} />}
            </div>
          </div>
        ) : (
          <Empty title="No project selected">
            <p>Create a project from a folder that holds your documentation, then start Plexus.</p>
            <button className="primary" onClick={() => setShowNew(true)}><Ic i={Plus} />New project</button>
          </Empty>
        )}
      </main>

      {showChat && mode !== 'docked' && !peek && <div className="edge-peek" onMouseEnter={hoverIn} aria-hidden />}
      {showChat && (
        <ChatPanel s={s} detail={d!} visible={chatVisible} mode={mode} tabs={tabs} active={active} onActivate={setActive} onClose={close}
          onPin={() => { setPinned(true); setPeek(false); }} onUnpin={() => { setPinned(false); setPeek(false); }} onHide={() => setPeek(false)}
          onMouseEnter={mode !== 'docked' ? hoverIn : undefined} onMouseLeave={mode !== 'docked' ? hoverOut : undefined}
          resizer={<Resizer side="left" width={rw} min={RIGHT.min} max={RIGHT.max} onWidth={setRightW} onReset={() => setRightW(RIGHT.def)} label="Resize chat" />} />
      )}
      {showNew && <NewProjectDialog onClose={() => setShowNew(false)} onCreated={id => { setShowNew(false); setSelected(id); s.loadProjects(); }} onError={s.setError} />}
      {settings && <SettingsDialog tab={settings} onTab={setSettings} onClose={() => setSettings(null)} accounts={s.accounts} reloadAccounts={s.loadAccounts} onError={s.setError} />}
    </div>
  );
}
