import { useState } from 'react';
import { Blocks, LogIn, Plus, Power, RefreshCw, Trash2, Users, UserCog } from 'lucide-react';
import { api, timeAgo } from '../api.ts';
import type { Account, Project } from '../types.ts';
import { ContextMenu, Dot, Ic, Meter, type MenuItem } from '../ui.tsx';

export type Page = 'project' | 'accounts' | 'roles' | 'skills';

interface Props {
  projects: Project[];
  accounts: Account[];
  connected: boolean;
  page: Page;
  selected: string | null;
  onProject: (id: string) => void;
  onPage: (p: Page) => void;
  onNew: () => void;
  reloadAccounts: () => void;
  onError: (e: string) => void;
}

export function Sidebar(p: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <svg className="mark" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="2" /><circle cx="2.5" cy="3.5" r="1.25" /><circle cx="13.5" cy="4" r="1.25" /><circle cx="12" cy="13" r="1.25" /><path d="M3.5 4.3 6.4 7M12.4 4.7 9.6 7M11.2 12.1 9.4 9.4" /></svg>
        <span>Plexus</span>
        <span className="spacer" />
        <span className={`conn ${p.connected ? 'ok' : 'bad'}`} title={p.connected ? 'Connected to the daemon' : 'Daemon not reachable'} />
      </div>

      <div className="side-group projects">
        <div className="side-label">Projects <button className="icon-btn" title="New project" onClick={p.onNew}><Ic i={Plus} /></button></div>
        <div className="project-list">
          {p.projects.map(pr => (
            <button key={pr.id} className={`nav-row ${p.page === 'project' && p.selected === pr.id ? 'active' : ''}`} onClick={() => p.onProject(pr.id)} title={pr.path}>
              <span className="nav-ic"><Dot state={pr.status} /></span>
              <span className="nav-text">{pr.name}</span>
              <span className="nav-meta">{pr.phase}</span>
            </button>
          ))}
          {!p.projects.length && <div className="side-empty">No projects yet</div>}
        </div>
      </div>

      <div className="side-group">
        <div className="side-label">Setup</div>
        <button className={`nav-row ${p.page === 'accounts' ? 'active' : ''}`} onClick={() => p.onPage('accounts')}><span className="nav-ic"><Ic i={Users} /></span><span className="nav-text">Accounts</span></button>
        <button className={`nav-row ${p.page === 'roles' ? 'active' : ''}`} onClick={() => p.onPage('roles')}><span className="nav-ic"><Ic i={UserCog} /></span><span className="nav-text">Roles</span></button>
        <button className={`nav-row ${p.page === 'skills' ? 'active' : ''}`} onClick={() => p.onPage('skills')}><span className="nav-ic"><Ic i={Blocks} /></span><span className="nav-text">Skills</span></button>
      </div>

      <QuotaDock accounts={p.accounts} reload={p.reloadAccounts} onError={p.onError} onManage={() => p.onPage('accounts')} />
    </aside>
  );
}

/** Bottom-left: every account's 5-hour and weekly quota. Right-click a row for refresh, disable and remove. */
function QuotaDock({ accounts, reload, onError, onManage }: { accounts: Account[]; reload: () => void; onError: (e: string) => void; onManage: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number; a: Account } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const call = (id: string, pr: Promise<unknown>) => { setBusy(id); return pr.then(reload).catch(e => onError(e.message)).finally(() => setBusy(null)); };

  const items = (a: Account): MenuItem[] => [
    { label: 'Refresh status', icon: RefreshCw, onSelect: () => call(a.id, api('POST', `/api/accounts/${a.id}/probe`)) },
    ...(a.state === 'needs_login' && a.provider !== 'mock'
      ? [{ label: 'Log in', icon: LogIn, onSelect: () => call(a.id, api('POST', `/api/accounts/${a.id}/login`)) }] : []),
    { label: a.enabled ? 'Disable' : 'Enable', icon: Power, onSelect: () => call(a.id, api('PATCH', `/api/accounts/${a.id}`, { enabled: !a.enabled })) },
    { label: 'Remove', icon: Trash2, danger: true, onSelect: () => { if (confirm(`Remove ${a.label}? Its login folder is kept on disk.`)) void call(a.id, api('DELETE', `/api/accounts/${a.id}`)); } },
  ];

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
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items(menu.a)} onClose={() => setMenu(null)} />}
    </section>
  );
}
