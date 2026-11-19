// Settings dialog: accounts, roles and skills. Edits that can be changed back save on their own;
// only things that cannot be undone (remove, delete, reset) ask first.
import { useEffect, useRef, useState } from 'react';
import { Blocks, Check, ChevronDown, GripVertical, Plus, UserCog, Users, X } from 'lucide-react';
import { api, clock } from './api.ts';
import type { Account, ModelCatalog, Provider, Role, Skill } from './types.ts';
import { ContextMenu, Dot, Ic, Meter } from './ui.tsx';
import { FALLBACK, effortsFor, useModels } from './models.tsx';
import { accountItems } from './components/Sidebar.tsx';

export type SettingsTab = 'accounts' | 'roles' | 'skills';
const TABS: { id: SettingsTab; label: string; icon: typeof Users }[] = [
  { id: 'accounts', label: 'Accounts', icon: Users },
  { id: 'roles', label: 'Roles', icon: UserCog },
  { id: 'skills', label: 'Skills', icon: Blocks },
];

export function SettingsDialog({ tab, onTab, onClose, accounts, reloadAccounts, onError }: {
  tab: SettingsTab; onTab: (t: SettingsTab) => void; onClose: () => void; accounts: Account[]; reloadAccounts: () => void; onError: (e: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.menu, .drawer')) onClose(); };
    addEventListener('keydown', key);
    ref.current?.focus();
    return () => removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} tabIndex={-1} className="dialog settings" role="dialog" aria-label="Settings">
        <nav className="settings-nav" role="tablist" aria-label="Settings sections">
          <div className="settings-title">Settings</div>
          {TABS.map(t => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`nav-row ${tab === t.id ? 'active' : ''}`} onClick={() => onTab(t.id)}>
              <span className="nav-ic"><Ic i={t.icon} /></span><span className="nav-text">{t.label}</span>
            </button>
          ))}
          <div className="settings-note">Changes save as you make them</div>
        </nav>
        <div className="settings-main">
          <button className="icon-btn settings-close" onClick={onClose} title="Close" aria-label="Close settings"><Ic i={X} /></button>
          <div className="settings-body">
            {tab === 'accounts' && <AccountsSettings accounts={accounts} reload={reloadAccounts} onError={onError} />}
            {tab === 'roles' && <RolesSettings onError={onError} />}
            {tab === 'skills' && <SkillsSettings onError={onError} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- shared

type SaveState = 'idle' | 'saving' | 'saved';
const SaveMark = ({ s }: { s: SaveState }) => (
  <span className={`save-mark ${s}`} aria-live="polite">{s === 'saving' ? 'Saving' : s === 'saved' ? <><Ic i={Check} size={14} />Saved</> : ''}</span>
);

/** Runs the latest call per key after a pause in typing. */
function useDebouncer(ms = 500) {
  const t = useRef<Record<string, number>>({});
  const fns = useRef<Record<string, () => void>>({});
  useEffect(() => () => { for (const k of Object.keys(fns.current)) { clearTimeout(t.current[k]); fns.current[k](); } }, []);
  return (key: string, fn: () => void) => {
    clearTimeout(t.current[key]);
    fns.current[key] = fn;
    t.current[key] = window.setTimeout(() => { delete fns.current[key]; fn(); }, ms);
  };
}

/** Number input that keeps what is being typed and reports only valid values. */
function NumField({ value, min, max, onValue, className = 'num-input', label }: { value: number; min: number; max: number; onValue: (n: number) => void; className?: string; label?: string }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);
  return (
    <input className={className} type="number" min={min} max={max} value={text} aria-label={label}
      onFocus={() => { focused.current = true; }}
      onChange={e => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(n) && n >= min && n <= max) onValue(Math.floor(n));
      }}
      onBlur={() => { focused.current = false; setText(String(value)); }} />
  );
}

// ---------------------------------------------------------------- accounts

function AccountsSettings({ accounts, reload, onError }: { accounts: Account[]; reload: () => void; onError: (e: string) => void }) {
  const [provider, setProvider] = useState<Provider>('claude');
  const [lbl, setLbl] = useState('');
  const [id, setId] = useState('');
  const [msg, setMsg] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; a: Account } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<SaveState>('idle');
  const debounce = useDebouncer();

  const call = (aid: string, p: Promise<unknown>) => { setBusy(aid); return p.then(r => { reload(); return r; }).catch(e => onError(e.message)).finally(() => setBusy(null)); };
  const patch = (a: Account, body: Partial<Account>) => {
    setSaved('saving');
    debounce(`${a.id}:${Object.keys(body).join()}`, () => void api('PATCH', `/api/accounts/${a.id}`, body).then(() => { reload(); setSaved('saved'); }).catch(e => { setSaved('idle'); onError(e.message); }));
  };
  const add = () => api<Account>('POST', '/api/accounts', { provider, label: lbl || undefined, id: id || undefined }).then(a => {
    reload(); setLbl(''); setId('');
    setMsg(a.provider === 'mock' ? `${a.id} added` : `${a.id} added. Right-click it and choose Log in to sign in with this account`);
  }).catch(e => onError(e.message));
  const login = (a: Account) => call(a.id, api<{ opened: boolean; command: string }>('POST', `/api/accounts/${a.id}/login`)).then(r => {
    const x = r as { opened: boolean; command: string } | undefined;
    if (x) setMsg(x.opened ? `A login window opened for ${a.id}. Finish the sign-in in the browser, then choose Refresh status` : `Run in a terminal: ${x.command}`);
  });
  const rename = (a: Account, v: string) => {
    setRenaming(null);
    const t = v.trim();
    if (t && t !== a.label) { setSaved('saving'); void api('PATCH', `/api/accounts/${a.id}`, { label: t }).then(() => { reload(); setSaved('saved'); }).catch(e => { setSaved('idle'); onError(e.message); }); }
  };
  const openMenu = (a: Account, x: number, y: number) => setMenu({ x, y, a });

  return (
    <section>
      <div className="settings-head"><h2>Accounts</h2><SaveMark s={saved} /></div>
      <p className="lead">Each account has its own folder, so several Claude or Codex accounts can run on this machine. Plexus spreads work across them and hands tasks over when one runs out of quota. Right-click an account to rename, sign in, refresh or remove it.</p>
      <div className="toolbar">
        <select value={provider} onChange={e => setProvider(e.target.value as Provider)} aria-label="Provider"><option value="claude">Claude (Claude Code)</option><option value="codex">ChatGPT (Codex CLI)</option><option value="mock">Mock (testing)</option></select>
        <input placeholder="Label" value={lbl} onChange={e => setLbl(e.target.value)} />
        <input placeholder="ID" value={id} onChange={e => setId(e.target.value)} />
        <button className="primary" onClick={add}><Ic i={Plus} />Add account</button>
      </div>
      {msg && <div className="banner info" role="status" onClick={() => setMsg('')}>{msg}</div>}
      <div className="table-wrap">
        <table className="table accounts">
          <thead><tr><th>Account</th><th>State</th><th className="c-meter">5h</th><th className="c-meter">Week</th><th className="r">Parallel</th><th className="r">Priority</th></tr></thead>
          <tbody>
            {accounts.map(a => (
              <tr key={a.id} tabIndex={0} className={`${menu?.a.id === a.id ? 'menu-open' : ''} ${busy === a.id ? 'busy' : ''}`}
                onContextMenu={e => { if ((e.target as HTMLElement).closest('input')) return; e.preventDefault(); openMenu(a, e.clientX, e.clientY); }}
                onKeyDown={e => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); openMenu(a, r.left + 16, r.bottom); }
                  if (e.key === 'F2') setRenaming(a.id);
                }}>
                <td className="c-name">
                  {renaming === a.id
                    ? <input className="cell-input" autoFocus defaultValue={a.label} aria-label="Account name" onFocus={e => e.currentTarget.select()} onBlur={e => rename(a, e.currentTarget.value)}
                        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(null); }} />
                    : <div className="acct-name" onDoubleClick={() => setRenaming(a.id)}>{a.label}</div>}
                  <div className="sub"><span className="mono">{a.id}</span> · {a.provider}{a.quota?.plan ? ` · ${a.quota.plan}` : ''}</div>
                </td>
                <td>
                  <span className="state"><Dot state={a.enabled ? a.state : 'disabled'} />{busy === a.id ? 'checking' : a.enabled ? a.state.replace('_', ' ') : 'disabled'}</span>
                  {a.stateReason && <div className="sub clip" title={a.stateReason}>{a.stateReason}</div>}
                  {a.cooldownUntil && <div className="sub num">until {clock(a.cooldownUntil)}</div>}
                </td>
                <td className="c-meter"><Meter w={a.quota?.primary} name="5h" /></td>
                <td className="c-meter"><Meter w={a.quota?.secondary} name="Week" /></td>
                <td className="r"><NumField value={a.maxConcurrency} min={1} max={8} label="Parallel tasks" onValue={n => patch(a, { maxConcurrency: n })} /></td>
                <td className="r"><NumField value={a.priority} min={-100} max={100} label="Priority" onValue={n => patch(a, { priority: n })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!accounts.length && <div className="stream-empty">No accounts yet. Add one above</div>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
        items={accountItems(menu.a, call, { onRename: () => setRenaming(menu.a.id), onLogin: menu.a.provider !== 'mock' ? () => void login(menu.a) : undefined })} />}
    </section>
  );
}

// ---------------------------------------------------------------- roles

const PROVIDERS = ['claude', 'codex', 'mock'] as const;
const PROVIDER_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', mock: 'Mock' };

function modelOptions(catalog: ModelCatalog, p: Provider): { id: string; label: string; note?: string }[] {
  const list = (catalog[p] ?? []).filter(m => !m.hidden);
  return list.length ? list.map(m => ({ id: m.id, label: m.label || m.id, note: m.description })) : FALLBACK[p].map(id => ({ id, label: id }));
}
export function modelLabel(catalog: ModelCatalog, p: Provider, model: string | undefined): string {
  if (!model) return 'default model';
  const w = model.toLowerCase();
  const m = (catalog[p] ?? []).find(x => x.id.toLowerCase() === w || x.resolved?.toLowerCase() === w);
  return m?.label || model;
}

/** Model and effort for one provider, as choices you click instead of fields you type into. */
export function ModelEffort({ provider, model, effort, catalog, onModel, onEffort, inherited, className = '' }: {
  provider: Provider; model: string | undefined; effort: string | undefined; catalog: ModelCatalog;
  onModel: (m: string | undefined) => void; onEffort: (e: string | undefined) => void;
  /** What Default means here when it comes from somewhere else (the coordinator role). */
  inherited?: { model?: string; effort?: string };
  className?: string;
}) {
  const options = modelOptions(catalog, provider);
  const known = !model || options.some(o => o.id.toLowerCase() === model.toLowerCase());
  const [other, setOther] = useState(!known);
  const { efforts, known: knownModel, defaultEffort: cliEffort } = effortsFor(catalog, provider, model || inherited?.model);
  const defaultEffort = inherited?.effort ?? cliEffort;
  const unsupported = !!effort && knownModel && !efforts.includes(effort);
  return (
    <div className={`me ${className}`}>
      <div className="me-row">
        <span className="me-label">Model</span>
        <div className="seg" role="radiogroup" aria-label="Model">
          <button role="radio" aria-checked={!model && !other} onClick={() => { setOther(false); onModel(undefined); }}>Default{inherited?.model ? ` (${modelLabel(catalog, provider, inherited.model)})` : ''}</button>
          {options.map(o => (
            <button key={o.id} role="radio" aria-checked={!other && model?.toLowerCase() === o.id.toLowerCase()} title={o.note ?? o.id}
              onClick={() => { setOther(false); onModel(o.id); }}>{o.label}</button>
          ))}
          <button role="radio" aria-checked={other} onClick={() => setOther(true)}>Other</button>
        </div>
      </div>
      {other && (
        <div className="me-row">
          <span className="me-label" />
          <input className="me-input mono" autoFocus={known} defaultValue={known ? '' : model} placeholder="Model id, as the CLI takes it" aria-label="Model id"
            onBlur={e => onModel(e.currentTarget.value.trim() || undefined)}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        </div>
      )}
      <div className="me-row">
        <span className="me-label">Effort</span>
        {efforts.length || effort ? (
          <div className="seg" role="radiogroup" aria-label="Reasoning effort">
            <button role="radio" aria-checked={!effort} onClick={() => onEffort(undefined)}>Default{defaultEffort ? ` (${defaultEffort})` : ''}</button>
            {efforts.map(e => <button key={e} role="radio" aria-checked={effort === e} onClick={() => onEffort(e)}>{e}</button>)}
            {effort && !efforts.includes(effort) && <button role="radio" aria-checked className={unsupported ? 'warn' : ''} title={unsupported ? 'This model does not take this effort; it will be ignored' : undefined}>{effort}</button>}
          </div>
        ) : <span className="sub">{knownModel ? 'This model has no effort setting' : 'No effort information yet'}</span>}
      </div>
    </div>
  );
}

/** The role's providers as blocks, best first. Drag a block by its grip to change the order. */
function PreferenceList({ role, set }: { role: Role; set: (p: Partial<Role>) => void }) {
  const list = role.providers;
  const catalog = useModels();
  const [open, setOpen] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= list.length) return;
    const n = [...list]; const [x] = n.splice(from, 1); n.splice(to, 0, x);
    set({ providers: n });
  };
  const remove = (p: Provider) => {
    const models = { ...role.models }, efforts = { ...role.efforts };
    delete models[p]; delete efforts[p];
    set({ providers: list.filter(x => x !== p), models, efforts, onlyListed: list.length > 1 && role.onlyListed });
  };
  const free = PROVIDERS.filter(p => !list.includes(p));
  useEffect(() => { const up = () => setArmed(null); addEventListener('pointerup', up); return () => removeEventListener('pointerup', up); }, []);

  return (
    <div className="pref" onDragOver={e => { if (drag) e.preventDefault(); }}>
      {list.map((p, i) => {
        const isOpen = open === p;
        const effort = role.efforts?.[p];
        const drop = drag && drag.over === i && drag.from !== i ? (drag.from < i ? 'drop-after' : 'drop-before') : '';
        return (
          <div key={p} className={`pref-block ${isOpen ? 'open' : ''} ${drag?.from === i ? 'dragging' : ''} ${drop}`}
            draggable={armed === p}
            onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p); setDrag({ from: i, over: i }); }}
            onDragOver={e => { if (!drag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (drag.over !== i) setDrag({ ...drag, over: i }); }}
            onDrop={e => { e.preventDefault(); if (drag) move(drag.from, i); setDrag(null); setArmed(null); }}
            onDragEnd={() => { setDrag(null); setArmed(null); }}>
            <div className="pref-head">
              <span className="pref-grip" title="Drag to reorder" aria-hidden onPointerDown={() => setArmed(p)}><Ic i={GripVertical} /></span>
              <span className="pref-rank num">{i + 1}</span>
              <button className="pref-summary" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : p)}
                title="Alt + arrow keys to reorder"
                onKeyDown={e => {
                  if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); move(i, i - 1); }
                  if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); move(i, i + 1); }
                }}>
                <span className="pref-name">{PROVIDER_NAME[p] ?? p}</span>
                <span className="pref-model">{modelLabel(catalog, p, role.models[p])}</span>
                <span className="pref-effort">{effort ?? 'default effort'}</span>
                <span className="pref-chev"><Ic i={ChevronDown} size={14} /></span>
              </button>
              <button className="icon-btn" title={`Remove ${PROVIDER_NAME[p]}`} aria-label={`Remove ${PROVIDER_NAME[p]}`} onClick={() => remove(p)}><Ic i={X} /></button>
            </div>
            {isOpen && (
              <ModelEffort provider={p} model={role.models[p]} effort={effort} catalog={catalog}
                onModel={m => set({ models: { ...role.models, [p]: m } })}
                onEffort={v => set({ efforts: { ...role.efforts, [p]: v } })} />
            )}
          </div>
        );
      })}
      {free.length > 0 && (
        <div className="pref-add">
          {free.map(p => <button key={p} className="ghost" onClick={() => { set({ providers: [...list, p] }); setOpen(p); }}><Ic i={Plus} />{PROVIDER_NAME[p]}</button>)}
        </div>
      )}
    </div>
  );
}

const ROLE_NAME = /^[a-z0-9][a-z0-9-]*$/;

function RolesSettings({ onError }: { onError: (e: string) => void }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [cur, setCur] = useState<Role | null>(null);
  const [saved, setSaved] = useState<SaveState>('idle');
  const [naming, setNaming] = useState(false);
  const pending = useRef<Role | null>(null);
  const timer = useRef<number>(undefined);
  const err = useRef(onError); err.current = onError;

  const load = () => Promise.all([api<Role[]>('GET', '/api/roles'), api<Skill[]>('GET', '/api/skills')]).then(([r, s]) => { setRoles(r); setSkills(s); return r; });
  const flush = () => {
    clearTimeout(timer.current);
    const r = pending.current;
    pending.current = null;
    if (!r) return;
    void api<Role>('PUT', `/api/roles/${r.name}`, r)
      .then(x => { setRoles(rs => rs.map(y => (y.name === x.name ? x : y))); if (!pending.current) setSaved('saved'); })
      .catch(e => { setSaved('idle'); err.current(e.message); });
  };
  useEffect(() => { load().then(r => setCur(c => c ?? r[0] ?? null)).catch(e => onError(e.message)); return flush; }, []);

  const set = (patch: Partial<Role>) => {
    if (!cur) return;
    const n = { ...cur, ...patch };
    setCur(n);
    pending.current = n;
    setSaved('saving');
    clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 500);
  };
  const select = (r: Role) => { flush(); setSaved('idle'); setCur(r); };
  const create = (raw: string) => {
    setNaming(false);
    const name = raw.trim().toLowerCase();
    if (!name) return;
    if (!ROLE_NAME.test(name)) { onError('Role names use lowercase letters, digits and dashes, for example security-auditor'); return; }
    if (roles.some(r => r.name === name)) { select(roles.find(r => r.name === name)!); return; }
    const r: Role = { name, description: '', providers: [], models: {}, efforts: {}, skills: [], writesCode: true, maxRuntimeMin: 60, onlyListed: false, maxParallel: 0, instructions: `You are the ${name}.\n` };
    flush();
    api<Role>('PUT', `/api/roles/${name}`, r).then(x => { void load(); setCur(x); setSaved('saved'); }).catch(e => onError(e.message));
  };

  return (
    <section className="roles">
      <div className="roles-list" role="listbox" aria-label="Roles">
        {roles.map(r => (
          <button key={r.name} role="option" aria-selected={cur?.name === r.name} className={`list-row ${cur?.name === r.name ? 'active' : ''}`} onClick={() => select(r)}>
            <div>{r.name}</div><div className="sub">{r.description}</div>
          </button>
        ))}
        {naming
          ? <input className="new-role" autoFocus placeholder="security-auditor" aria-label="New role name" onBlur={e => create(e.currentTarget.value)}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setNaming(false); }} />
          : <button className="ghost" onClick={() => setNaming(true)}><Ic i={Plus} />New role</button>}
      </div>
      {cur && (
        <div className="editor">
          <div className="settings-head"><h2>{cur.name}</h2><SaveMark s={saved} /></div>
          <label>Description<input value={cur.description} onChange={e => set({ description: e.target.value })} /></label>

          <div className="lbl">Preferred AI<span className="field-note">Best first. Drag to reorder, click to set model and effort</span></div>
          <PreferenceList role={cur} set={set} />
          <label className="check"><input type="checkbox" checked={cur.onlyListed} disabled={!cur.providers.length} onChange={e => set({ onlyListed: e.target.checked })} />Only use these providers</label>
          <div className="sub pref-note">
            {!cur.providers.length ? 'No preference: any account can run this role'
              : cur.onlyListed ? 'Tasks wait when every listed provider is out of quota'
              : 'When every listed provider is out of quota, any other account takes over'}
          </div>

          <div className="role-grid">
            <label>Running at once<span className="field-note">Per project, 0 means no limit</span>
              <NumField className="" value={cur.maxParallel} min={0} max={20} onValue={n => set({ maxParallel: n })} /></label>
            <label>Max runtime<span className="field-note">Minutes</span>
              <NumField className="" value={cur.maxRuntimeMin} min={1} max={1440} onValue={n => set({ maxRuntimeMin: n })} /></label>
          </div>
          <label className="check"><input type="checkbox" checked={cur.writesCode} onChange={e => set({ writesCode: e.target.checked })} />Writes code (gets its own branch, changes are merged)</label>

          <div className="lbl">Skills</div>
          <div className="skill-checks">
            {skills.map(s => <label key={s.name} className="check"><input type="checkbox" checked={cur.skills.includes(s.name)} onChange={e => set({ skills: e.target.checked ? [...cur.skills, s.name] : cur.skills.filter(x => x !== s.name) })} />{s.name}{!s.enabled && <span className="sub">disabled</span>}</label>)}
            {!skills.length && <div className="sub">No skills installed</div>}
          </div>

          <label>Instructions<textarea className="tall" value={cur.instructions} onChange={e => set({ instructions: e.target.value })} spellCheck={false} /></label>
          <div className="row">
            <button onClick={() => confirm(`Reset ${cur.name} to its default? Your changes to this role are lost.`) && api<Role>('POST', `/api/roles/${cur.name}/reset`).then(r => { pending.current = null; setCur(r); setSaved('saved'); void load(); }).catch(e => onError(e.message))}>Reset to default</button>
            <span className="spacer" />
            <button className="danger" onClick={() => confirm(`Delete role ${cur.name}?`) && api('DELETE', `/api/roles/${cur.name}`).then(() => { pending.current = null; setCur(null); setSaved('idle'); void load(); }).catch(e => onError(e.message))}>Delete role</button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- skills

function SkillsSettings({ onError }: { onError: (e: string) => void }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [source, setSource] = useState('');
  const [review, setReview] = useState<{ name: string; files: { path: string; size: number; content: string }[] } | null>(null);
  const [draft, setDraft] = useState({ name: '', description: '', body: '' });
  const load = () => api<Skill[]>('GET', '/api/skills').then(setSkills).catch(e => onError(e.message));
  useEffect(() => { void load(); }, []);
  const installed = (r: Skill[]) => { void load(); if (r[0]) void openReview(r[0].name); };
  const install = () => api<Skill[]>('POST', '/api/skills/install', { source }).then(r => { setSource(''); installed(r); }).catch(e => onError(e.message));
  const upload = async (f: File) => {
    const data = btoa(Array.from(new Uint8Array(await f.arrayBuffer()), b => String.fromCharCode(b)).join(''));
    api<Skill[]>('POST', '/api/skills/upload', { filename: f.name, data }).then(installed).catch(e => onError(e.message));
  };
  const openReview = (name: string) => api('GET', `/api/skills/${name}/files`).then(files => setReview({ name, files })).catch(e => onError(e.message));
  const create = () => api('POST', '/api/skills', draft).then(() => { setDraft({ name: '', description: '', body: '' }); void load(); }).catch(e => onError(e.message));
  return (
    <section>
      <div className="settings-head"><h2>Skills</h2></div>
      <p className="lead">Skills are folders with a <code>SKILL.md</code> in the Agent Skills format. They are copied into each task's workspace for the roles that use them, for both Claude Code and Codex. Installed skills start disabled: review the files, then enable.</p>
      <div className="toolbar wrap">
        <input className="grow" placeholder="Local folder, .zip path or git URL" value={source} onChange={e => setSource(e.target.value)} aria-label="Skill source" />
        <button className="primary" disabled={!source} onClick={install}>Install</button>
        <label className="button">Upload .zip<input type="file" accept=".zip" hidden onChange={e => e.target.files?.[0] && upload(e.target.files[0])} /></label>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Skill</th><th className="c-desc">Description</th><th>Enabled</th><th /></tr></thead>
          <tbody>{skills.map(s => (
            <tr key={s.name}>
              <td>{s.name}<div className="sub mono clip" title={s.source}>{s.source}</div></td>
              <td className="sub c-desc">{s.description}</td>
              <td><input type="checkbox" aria-label={`Enable ${s.name}`} checked={s.enabled} onChange={e => api('PATCH', `/api/skills/${s.name}`, { enabled: e.target.checked }).then(load).catch(er => onError(er.message))} /></td>
              <td className="actions"><button onClick={() => openReview(s.name)}>Review files</button><button className="danger" onClick={() => confirm(`Delete skill ${s.name}?`) && api('DELETE', `/api/skills/${s.name}`).then(load)}>Delete</button></td>
            </tr>))}</tbody>
        </table>
        {!skills.length && <div className="stream-empty">No skills installed</div>}
      </div>
      <h2>Write a new skill</h2>
      <div className="grid2">
        <label>Name<input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="react-conventions" /></label>
        <label>Description<span className="field-note">When agents should use it</span><input value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
      </div>
      <label>Instructions in markdown<textarea className="tall" value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} /></label>
      <button className="primary" disabled={!draft.name} onClick={create}>Create skill</button>
      {review && (
        <div className="backdrop right" onMouseDown={e => { if (e.target === e.currentTarget) setReview(null); }}>
          <div className="drawer">
            <div className="dialog-head"><h2>Review {review.name}</h2><button className="icon-btn" onClick={() => setReview(null)} title="Close"><Ic i={X} /></button></div>
            <p className="sub">Check every file. Agents can run scripts in a skill with full permissions.</p>
            {review.files.map(f => <div key={f.path}><h4 className="mono">{f.path} <span className="sub num">{f.size} B</span></h4><pre className="pre">{f.content}</pre></div>)}
            <div className="row"><button className="primary" onClick={() => api('PATCH', `/api/skills/${review.name}`, { enabled: true }).then(() => { setReview(null); void load(); })}>Enable this skill</button></div>
          </div>
        </div>
      )}
    </section>
  );
}
