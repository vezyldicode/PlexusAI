import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react';
import { api, clock } from './api.ts';
import type { Account, Project, Role, Skill } from './types.ts';
import { Dot, Ic, Meter } from './ui.tsx';
import { EffortSelect, ModelDatalist, useModels } from './models.tsx';

// ---------------------------------------------------------------- new project

export function NewProjectDialog({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (id: string) => void; onError: (e: string) => void }) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [maxParallel, setMaxParallel] = useState(3);
  const [start, setStart] = useState(true);
  const create = () => api<Project>('POST', '/api/projects', { path, name: name || undefined, goal, start, settings: { maxParallel } }).then(p => onCreated(p.id)).catch(e => onError(e.message));
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="New project" onClick={e => e.stopPropagation()}>
        <div className="dialog-head"><h2>New project</h2><button className="icon-btn" onClick={onClose} title="Close"><Ic i={X} /></button></div>
        <label>Project folder<span className="field-note">Absolute path, created if missing</span><input value={path} onChange={e => setPath(e.target.value)} placeholder="G:\work\my-app" autoFocus /></label>
        <label>Name<span className="field-note">Optional</span><input value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Goal<span className="field-note">Optional when the folder has GOAL.md or docs</span><textarea value={goal} onChange={e => setGoal(e.target.value)} rows={5} placeholder="What should the finished product do" /></label>
        <label>Parallel tasks<input type="number" min={1} max={10} value={maxParallel} onChange={e => setMaxParallel(Number(e.target.value))} /></label>
        <label className="check"><input type="checkbox" checked={start} onChange={e => setStart(e.target.checked)} />Start Plexus right away</label>
        <div className="row end"><button onClick={onClose}>Cancel</button><button className="primary" disabled={!path} onClick={create}>Create project</button></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- accounts

export function AccountsPage({ accounts, reload, onError }: { accounts: Account[]; reload: () => void; onError: (e: string) => void }) {
  const [provider, setProvider] = useState<'claude' | 'codex' | 'mock'>('claude');
  const [lbl, setLbl] = useState('');
  const [id, setId] = useState('');
  const [msg, setMsg] = useState('');
  const call = (p: Promise<any>) => p.then(r => { reload(); return r; }).catch(e => onError(e.message));
  const add = () => call(api('POST', '/api/accounts', { provider, label: lbl || undefined, id: id || undefined })).then(a => {
    if (a) { setLbl(''); setId(''); setMsg(a.provider === 'mock' ? `${a.id} added` : `${a.id} added. Click Log in to sign in with this account.`); }
  });
  const login = (a: Account) => call(api('POST', `/api/accounts/${a.id}/login`)).then(r => r && setMsg(r.opened ? `A login window opened for ${a.id}. Finish the sign-in in the browser, then click Refresh.` : `Run in a terminal: ${r.command}`));
  return (
    <div className="page">
      <h1>Accounts</h1>
      <p className="lead">Each account has its own folder, so several Claude or Codex accounts can run on this machine. Plexus spreads work across them and hands tasks over when one runs out of quota.</p>
      <div className="toolbar">
        <select value={provider} onChange={e => setProvider(e.target.value as any)}><option value="claude">Claude (Claude Code)</option><option value="codex">ChatGPT (Codex CLI)</option><option value="mock">Mock (testing)</option></select>
        <input placeholder="Label" value={lbl} onChange={e => setLbl(e.target.value)} />
        <input placeholder="ID" value={id} onChange={e => setId(e.target.value)} />
        <button className="primary" onClick={add}><Ic i={Plus} />Add account</button>
      </div>
      {msg && <div className="banner info" onClick={() => setMsg('')}>{msg}</div>}
      <table className="table">
        <thead><tr><th>Account</th><th>Provider</th><th>State</th><th>5h</th><th>Week</th><th className="r">Parallel</th><th className="r">Priority</th><th>Home</th><th /></tr></thead>
        <tbody>
          {accounts.map(a => (
            <tr key={a.id}>
              <td><div>{a.label}</div><div className="sub mono">{a.id}</div></td>
              <td>{a.provider}{a.quota?.plan ? <div className="sub">{a.quota.plan}</div> : null}</td>
              <td><span className="state"><Dot state={a.enabled ? a.state : 'disabled'} />{a.enabled ? a.state.replace('_', ' ') : 'disabled'}</span>{a.stateReason && <div className="sub" title={a.stateReason}>{a.stateReason.slice(0, 60)}</div>}{a.cooldownUntil && <div className="sub num">until {clock(a.cooldownUntil)}</div>}</td>
              <td><Meter w={a.quota?.primary} name="" /></td>
              <td><Meter w={a.quota?.secondary} name="" /></td>
              <td className="r"><input className="num-input" type="number" min={1} max={8} defaultValue={a.maxConcurrency} onBlur={e => call(api('PATCH', `/api/accounts/${a.id}`, { maxConcurrency: Number(e.target.value) }))} /></td>
              <td className="r"><input className="num-input" type="number" defaultValue={a.priority} onBlur={e => call(api('PATCH', `/api/accounts/${a.id}`, { priority: Number(e.target.value) }))} /></td>
              <td className="mono sub" title={a.home}>{a.home.length > 38 ? '…' + a.home.slice(-38) : a.home}</td>
              <td className="actions">
                {a.provider !== 'mock' && <button onClick={() => login(a)}>Log in</button>}
                <button onClick={() => call(api('POST', `/api/accounts/${a.id}/probe`))} title={a.provider === 'claude' ? 'Runs one tiny request, uses a little quota' : 'Free'}>Refresh</button>
                <button onClick={() => call(api('PATCH', `/api/accounts/${a.id}`, { enabled: !a.enabled }))}>{a.enabled ? 'Disable' : 'Enable'}</button>
                <button className="danger" onClick={() => confirm(`Remove ${a.id}? Its login folder is kept.`) && call(api('DELETE', `/api/accounts/${a.id}`))}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- roles

const PROVIDERS = ['claude', 'codex', 'mock'] as const;
const PROVIDER_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex (ChatGPT)', mock: 'Mock' };
const MODEL_HINT: Record<string, string> = { claude: 'opus, sonnet, haiku', codex: 'CLI default', mock: '' };

/** Issue #4: the role's providers as an ordered list, best first, each with its own model. */
function PreferenceList({ role, set }: { role: Role; set: (p: Partial<Role>) => void }) {
  const list = role.providers;
  const move = (i: number, d: number) => { const n = [...list]; [n[i], n[i + d]] = [n[i + d], n[i]]; set({ providers: n }); };
  const remove = (p: string) => {
    const models = { ...role.models }, efforts = { ...role.efforts };
    delete (models as any)[p]; delete (efforts as any)[p];
    set({ providers: list.filter(x => x !== p), models, efforts, onlyListed: list.length > 1 && role.onlyListed });
  };
  const catalog = useModels();
  const free = PROVIDERS.filter(p => !list.includes(p));
  return (
    <div className="pref">
      {list.map((p, i) => (
        <div key={p} className="pref-row">
          <span className="pref-rank num">{i + 1}</span>
          <span className="pref-name">{PROVIDER_NAME[p] ?? p}</span>
          <input list={`role-models-${p}`} placeholder={MODEL_HINT[p] || 'Model'} value={role.models[p] ?? ''} onChange={e => set({ models: { ...role.models, [p]: e.target.value || undefined } })} />
          <ModelDatalist id={`role-models-${p}`} provider={p} catalog={catalog} />
          <EffortSelect catalog={catalog} provider={p} model={role.models[p]} value={role.efforts?.[p] ?? ''}
            onChange={v => set({ efforts: { ...role.efforts, [p]: v || undefined } })} />
          <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Ic i={ChevronUp} /></button>
          <button className="icon-btn" title="Move down" disabled={i === list.length - 1} onClick={() => move(i, 1)}><Ic i={ChevronDown} /></button>
          <button className="icon-btn" title="Remove" onClick={() => remove(p)}><Ic i={X} /></button>
        </div>
      ))}
      {free.length > 0 && (
        <select className="pref-add" value="" onChange={e => e.target.value && set({ providers: [...list, e.target.value as any] })}>
          <option value="">{list.length ? 'Add a fallback provider' : 'Add a preferred provider'}</option>
          {free.map(p => <option key={p} value={p}>{PROVIDER_NAME[p]}</option>)}
        </select>
      )}
    </div>
  );
}

export function RolesPage({ onError }: { onError: (e: string) => void }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [cur, setCur] = useState<Role | null>(null);
  const load = () => Promise.all([api<Role[]>('GET', '/api/roles'), api<Skill[]>('GET', '/api/skills')]).then(([r, s]) => { setRoles(r); setSkills(s); return r; });
  useEffect(() => { load().then(r => setCur(c => c ?? r[0] ?? null)); }, []);
  const save = () => cur && api<Role>('PUT', `/api/roles/${cur.name}`, cur).then(r => { setCur(r); void load(); }).catch(e => onError(e.message));
  const newRole = () => { const name = prompt('Role name, lowercase, for example security-auditor'); if (name) setCur({ name, description: '', providers: [], models: {}, efforts: {}, skills: [], writesCode: true, maxRuntimeMin: 60, onlyListed: false, maxParallel: 0, instructions: `You are the ${name}.\n` }); };
  const set = (patch: Partial<Role>) => cur && setCur({ ...cur, ...patch });
  return (
    <div className="page split">
      <div className="list">
        <h1>Roles</h1>
        {roles.map(r => <button key={r.name} className={`list-row ${cur?.name === r.name ? 'active' : ''}`} onClick={() => setCur(r)}><div>{r.name}</div><div className="sub">{r.description}</div></button>)}
        <button className="ghost" onClick={newRole}><Ic i={Plus} />New role</button>
      </div>
      {cur && (
        <div className="editor">
          <h2>{cur.name}</h2>
          <label>Description<input value={cur.description} onChange={e => set({ description: e.target.value })} /></label>
          <div className="grid2">
            <div>
              <div className="lbl">Preferred AI</div>
              <PreferenceList role={cur} set={set} />
              <label className="check"><input type="checkbox" checked={cur.onlyListed} disabled={!cur.providers.length} onChange={e => set({ onlyListed: e.target.checked })} />Only use these providers</label>
              <div className="sub pref-note">
                {!cur.providers.length ? 'No preference: any account can run this role'
                  : cur.onlyListed ? 'Tasks wait when every listed provider is out of quota'
                  : 'When every listed provider is out of quota, any other account takes over'}
              </div>
              <label>Running at once<span className="field-note">Per project, 0 means no limit</span>
                <input className="num-input" type="number" min={0} max={20} value={cur.maxParallel} onChange={e => set({ maxParallel: Math.max(0, Number(e.target.value) || 0) })} /></label>
            </div>
            <div>
              <div className="lbl">Skills</div>
              {skills.map(s => <label key={s.name} className="check"><input type="checkbox" checked={cur.skills.includes(s.name)} onChange={e => set({ skills: e.target.checked ? [...cur.skills, s.name] : cur.skills.filter(x => x !== s.name) })} />{s.name}{!s.enabled && <span className="sub">disabled</span>}</label>)}
              {!skills.length && <div className="sub">No skills installed</div>}
              <label className="check"><input type="checkbox" checked={cur.writesCode} onChange={e => set({ writesCode: e.target.checked })} />Writes code (gets its own branch, changes are merged)</label>
              <label>Max runtime in minutes<input type="number" value={cur.maxRuntimeMin} onChange={e => set({ maxRuntimeMin: Number(e.target.value) })} /></label>
            </div>
          </div>
          <label>Instructions<textarea className="tall" value={cur.instructions} onChange={e => set({ instructions: e.target.value })} spellCheck={false} /></label>
          <div className="row">
            <button className="primary" onClick={save}>Save</button>
            <button onClick={() => api<Role>('POST', `/api/roles/${cur.name}/reset`).then(r => { setCur(r); void load(); }).catch(e => onError(e.message))}>Reset to default</button>
            <span className="spacer" />
            <button className="danger" onClick={() => confirm(`Delete role ${cur.name}?`) && api('DELETE', `/api/roles/${cur.name}`).then(() => { setCur(null); void load(); }).catch(e => onError(e.message))}>Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- skills

export function SkillsPage({ onError }: { onError: (e: string) => void }) {
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
    <div className="page">
      <h1>Skills</h1>
      <p className="lead">Skills are folders with a <code>SKILL.md</code> in the Agent Skills format. They are copied into each task's workspace for the roles that use them, for both Claude Code and Codex. Installed skills start disabled: review the files, then enable.</p>
      <div className="toolbar">
        <input className="grow" placeholder="Local folder, .zip path or git URL, for example https://github.com/org/repo#path/to/skill" value={source} onChange={e => setSource(e.target.value)} />
        <button className="primary" disabled={!source} onClick={install}>Install</button>
        <label className="button">Upload .zip<input type="file" accept=".zip" hidden onChange={e => e.target.files?.[0] && upload(e.target.files[0])} /></label>
      </div>
      <table className="table">
        <thead><tr><th>Skill</th><th>Description</th><th>Source</th><th>Enabled</th><th /></tr></thead>
        <tbody>{skills.map(s => (
          <tr key={s.name}>
            <td>{s.name}</td><td className="sub">{s.description}</td><td className="sub mono">{s.source.slice(0, 50)}</td>
            <td><input type="checkbox" checked={s.enabled} onChange={e => api('PATCH', `/api/skills/${s.name}`, { enabled: e.target.checked }).then(load)} /></td>
            <td className="actions"><button onClick={() => openReview(s.name)}>Review files</button><button className="danger" onClick={() => confirm(`Delete skill ${s.name}?`) && api('DELETE', `/api/skills/${s.name}`).then(load)}>Delete</button></td>
          </tr>))}</tbody>
      </table>
      <h2>Write a new skill</h2>
      <div className="grid2">
        <label>Name<input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="react-conventions" /></label>
        <label>Description<span className="field-note">When should agents use it</span><input value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
      </div>
      <label>Instructions in markdown<textarea className="tall" value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} /></label>
      <button className="primary" disabled={!draft.name} onClick={create}>Create skill</button>
      {review && (
        <div className="backdrop right" onClick={() => setReview(null)}>
          <div className="drawer" onClick={e => e.stopPropagation()}>
            <div className="dialog-head"><h2>Review {review.name}</h2><button className="icon-btn" onClick={() => setReview(null)} title="Close"><Ic i={X} /></button></div>
            <p className="sub">Check every file. Agents can run scripts in a skill with full permissions.</p>
            {review.files.map(f => <div key={f.path}><h4 className="mono">{f.path} <span className="sub num">{f.size} B</span></h4><pre className="pre">{f.content}</pre></div>)}
            <div className="row"><button className="primary" onClick={() => api('PATCH', `/api/skills/${review.name}`, { enabled: true }).then(() => { setReview(null); void load(); })}>Enable this skill</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
