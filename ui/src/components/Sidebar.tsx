import { useState, type ReactNode } from 'react';
import { Copy, FolderOpen, LogIn, PanelLeftClose, Pencil, Plus, Power, RefreshCw, Settings, Trash2 } from 'lucide-react';
import { api, timeAgo } from '../api.ts';
import type { Account, Project } from '../types.ts';
import { ContextMenu, Dot, Ic, Meter, type MenuItem } from '../ui.tsx';

interface Props {
  projects: Project[];
  accounts: Account[];
  connected: boolean;
  selected: string | null;
  /** Icon rail instead of the full sidebar. */
  collapsed: boolean;
  /** Full sidebar drawn over the content (narrow windows). */
  overlay: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  onProject: (id: string) => void;
  onNew: () => void;
  onSettings: (tab?: 'accounts') => void;
  reloadProjects: () => void;
  reloadAccounts: () => void;
  onError: (e: string) => void;
  /** Drag handle on the right edge. */
  resizer?: ReactNode;
}

const Mark = () => (
  <svg className="mark" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="2" /><circle cx="2.5" cy="3.5" r="1.25" /><circle cx="13.5" cy="4" r="1.25" /><circle cx="12" cy="13" r="1.25" /><path d="M3.5 4.3 6.4 7M12.4 4.7 9.6 7M11.2 12.1 9.4 9.4" /></svg>
);

/** Right-click menu on a project: rename in place, open its folder, copy the path, remove it from Plexus. */
function useProjectMenu(reload: () => void, onError: (e: string) => void, beforeRename: () => void) {
  const [menu, setMenu] = useState<{ x: number; y: number; p: Project } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const items = (p: Project): MenuItem[] => [
    { label: 'Rename', icon: Pencil, onSelect: () => { beforeRename(); setRenaming(p.id); } },
    { label: 'Open folder', icon: FolderOpen, onSelect: () => void api('POST', `/api/projects/${p.id}/reveal`).catch(e => onError(e.message)) },
    { label: 'Copy path', icon: Copy, onSelect: () => void navigator.clipboard?.writeText(p.path).catch(() => onError('Could not copy to the clipboard')) },
    { label: 'Remove from Plexus', icon: Trash2, danger: true, onSelect: () => {
      if (confirm(`Remove ${p.name} from Plexus?\n\nIts tasks, chats and history are deleted. The files in ${p.path} stay on disk.`))
        void api('DELETE', `/api/projects/${p.id}`).then(reload).catch(e => onError(e.message));
    } },
  ];
  const rename = (p: Project, name: string) => {
    setRenaming(null);
    const n = name.trim();
    if (n && n !== p.name) void api('PATCH', `/api/projects/${p.id}`, { name: n }).then(reload).catch(e => onError(e.message));
  };
  const bind = (p: Project) => ({
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, p }); },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left + 16, y: r.bottom, p }); }
      if (e.key === 'F2') { e.preventDefault(); beforeRename(); setRenaming(p.id); }
    },
  });
  const node = menu && <ContextMenu x={menu.x} y={menu.y} items={items(menu.p)} onClose={() => setMenu(null)} />;
  return { bind, node, renaming, rename, cancelRename: () => setRenaming(null), startRename: setRenaming, menuFor: menu?.p.id };
}

export function Sidebar(p: Props) {
  // Renaming happens in the full sidebar, so a rename picked from the rail opens it first.
  const pm = useProjectMenu(p.reloadProjects, p.onError, () => { if (p.collapsed) p.onExpand(); });
  const [refresh, setRefresh] = useState<{ busy: boolean; note: string }>({ busy: false, note: '' });
  /** Re-probe every enabled account (state + 5h/weekly quota) on the daemon, then reload accounts and projects. */
  const refreshAll = async () => {
    if (refresh.busy) return;
    setRefresh({ busy: true, note: 'Refreshing…' });
    try {
      const r = await api<{ probed: number; failed: { id: string; error: string }[] }>('POST', '/api/accounts/probe');
      const ok = r.probed - r.failed.length;
      setRefresh({ busy: false, note: r.failed.length ? `${ok}/${r.probed} updated` : `${r.probed} updated` });
      if (r.failed.length) p.onError(`Refresh failed for ${r.failed.map(f => `${f.id} (${f.error})`).join(', ')}`);
    } catch (e: any) {
      setRefresh({ busy: false, note: '' });
      p.onError(e.message);
    }
    p.reloadAccounts(); p.reloadProjects();
    setTimeout(() => setRefresh(s => s.busy ? s : { busy: false, note: '' }), 3000);
  };
  const conn = <span className={`conn ${p.connected ? 'ok' : 'bad'}`} title={p.connected ? 'Connected to the daemon' : 'Daemon not reachable'} />;

  if (p.collapsed) return (
    <aside className="sidebar rail" aria-label="Navigation">
      <button className="rail-brand" title="Expand sidebar" aria-label="Expand sidebar" onClick={p.onExpand}><Mark /></button>
      <div className="rail-list">
        {p.projects.map(pr => (
          <button key={pr.id} className={`rail-btn ${p.selected === pr.id ? 'active' : ''} ${pm.menuFor === pr.id ? 'menu-open' : ''}`} title={`${pr.name}\n${pr.path}`} aria-label={pr.name}
            onClick={() => p.onProject(pr.id)} {...pm.bind(pr)}>
            <span className="rail-initial">{pr.name.trim().charAt(0).toUpperCase() || '?'}</span>
            <Dot state={pr.status} />
          </button>
        ))}
        <button className="rail-btn ghost-btn" title="New project" aria-label="New project" onClick={p.onNew}><Ic i={Plus} /></button>
      </div>
      <div className="rail-foot">
        <button className="rail-btn" title="Settings" aria-label="Settings" onClick={() => p.onSettings()}><Ic i={Settings} /></button>
        <span className="rail-conn">{conn}</span>
      </div>
      {pm.node}
    </aside>
  );

  return (
    <aside className={`sidebar ${p.overlay ? 'overlay' : ''}`} aria-label="Navigation">
      <div className="brand">
        <button className={`brand-btn ${refresh.busy ? 'busy' : ''}`} title="Refresh status and quota of all accounts" aria-busy={refresh.busy} onClick={refreshAll}><Mark /><span>Plexus</span></button>
        {refresh.note && <span className="brand-note" role="status">{refresh.note}</span>}
        {conn}
        <span className="spacer" />
        <button className="icon-btn" title="Collapse sidebar" aria-label="Collapse sidebar" onClick={p.onCollapse}><Ic i={PanelLeftClose} /></button>
      </div>

      <div className="side-group projects">
        <div className="side-label">Projects <button className="icon-btn" title="New project" onClick={p.onNew}><Ic i={Plus} /></button></div>
        <div className="project-list">
          {p.projects.map(pr => pm.renaming === pr.id ? (
            <div key={pr.id} className="nav-row editing">
              <span className="nav-ic"><Dot state={pr.status} /></span>
              <input className="nav-input" autoFocus defaultValue={pr.name} aria-label="Project name" onFocus={e => e.currentTarget.select()}
                onBlur={e => pm.rename(pr, e.currentTarget.value)}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') pm.cancelRename(); }} />
            </div>
          ) : (
            <button key={pr.id} className={`nav-row ${p.selected === pr.id ? 'active' : ''} ${pm.menuFor === pr.id ? 'menu-open' : ''}`} onClick={() => p.onProject(pr.id)} title={pr.path}
              onDoubleClick={() => pm.startRename(pr.id)} {...pm.bind(pr)}>
              <span className="nav-ic"><Dot state={pr.status} /></span>
              <span className="nav-text">{pr.name}</span>
              <span className="nav-meta">{pr.phase}</span>
            </button>
          ))}
          {!p.projects.length && <div className="side-empty">No projects yet</div>}
        </div>
      </div>

      <div className="side-group">
        <button className="nav-row" onClick={() => p.onSettings()}><span className="nav-ic"><Ic i={Settings} /></span><span className="nav-text">Settings</span></button>
      </div>

      <QuotaDock accounts={p.accounts} reload={p.reloadAccounts} onError={p.onError} onManage={() => p.onSettings('accounts')} />
      {pm.node}
      {p.resizer}
    </aside>
  );
}

/** Actions on one account, shared by the quota dock and the Accounts settings. */
export function accountItems(a: Account, call: (id: string, pr: Promise<unknown>) => unknown, extra: { onRename?: () => void; onLogin?: () => void } = {}): MenuItem[] {
  return [
    ...(extra.onRename ? [{ label: 'Rename', icon: Pencil, onSelect: extra.onRename }] : []),
    ...(a.provider !== 'mock' && (extra.onLogin || a.state === 'needs_login')
      ? [{ label: 'Log in', icon: LogIn, onSelect: extra.onLogin ?? (() => call(a.id, api('POST', `/api/accounts/${a.id}/login`))) }] : []),
    { label: 'Refresh status', icon: RefreshCw, onSelect: () => call(a.id, api('POST', `/api/accounts/${a.id}/probe`)) },
    { label: a.enabled ? 'Disable' : 'Enable', icon: Power, onSelect: () => call(a.id, api('PATCH', `/api/accounts/${a.id}`, { enabled: !a.enabled })) },
    { label: 'Remove', icon: Trash2, danger: true, onSelect: () => { if (confirm(`Remove ${a.label}? Its login folder is kept on disk.`)) void call(a.id, api('DELETE', `/api/accounts/${a.id}`)); } },
  ];
}

/** Bottom-left: every account's 5-hour and weekly quota. Right-click a row for refresh, disable and remove. */
function QuotaDock({ accounts, reload, onError, onManage }: { accounts: Account[]; reload: () => void; onError: (e: string) => void; onManage: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number; a: Account } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const call = (id: string, pr: Promise<unknown>) => { setBusy(id); return pr.then(reload).catch(e => onError(e.message)).finally(() => setBusy(null)); };

  return (
    <section className="dock" aria-label="Account quota">
      <div className="side-label">Quota <button className="link-btn" onClick={onManage}>Manage</button></div>
      <div className="dock-list">
        {accounts.map(a => {
          const state = a.enabled ? a.state : 'disabled';
          const waiting = a.cooldownUntil && Date.parse(a.cooldownUntil) > Date.now();
          return (
            <div key={a.id} tabIndex={0} className={`dock-row s-${state} ${busy === a.id ? 'busy' : ''} ${menu?.a.id === a.id ? 'menu-open' : ''}`}
              title={a.stateReason ?? undefined}
              onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, a }); }}
              onKeyDown={e => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left + 16, y: r.bottom, a }); } }}>
              <div className="dock-head">
                <Dot state={state} />
                <span className="dock-name">{a.label}</span>
                <span className="dock-meta">{busy === a.id ? 'checking' : (a.running ?? 0) > 0 ? `${a.running} running` : waiting ? `resets ${timeAgo(a.cooldownUntil)}` : state === 'ok' ? a.provider : state.replace('_', ' ')}</span>
              </div>
              <Meter w={a.quota?.primary} name="5h" />
              <Meter w={a.quota?.secondary} name="Week" />
            </div>
          );
        })}
        {!accounts.length && <button className="side-empty link-btn" onClick={onManage}>Add an account to start</button>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={accountItems(menu.a, call)} onClose={() => setMenu(null)} />}
    </section>
  );
}
