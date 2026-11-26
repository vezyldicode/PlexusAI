import { useState } from 'react';
import { ArrowLeft, FolderOpen, X } from 'lucide-react';
import { api } from './api.ts';
import type { Project } from './types.ts';
import { Ic } from './ui.tsx';

/** The system folder picker, shared by the new and edit project dialogs. */
function useFolderPicker(onPick: (path: string) => void, onError: (e: string) => void) {
  const [browsing, setBrowsing] = useState(false);
  const browse = async () => {
    setBrowsing(true);
    try {
      const chosen = await api<{ path: string | null }>('POST', '/api/folder-picker');
      if (chosen.path) onPick(chosen.path);
    } catch (e: any) { onError(e.message); }
    finally { setBrowsing(false); }
  };
  return { browsing, browse };
}

function FolderField({ value, onChange, browsing, onBrowse, note, autoFocus }: { value: string; onChange: (v: string) => void; browsing: boolean; onBrowse: () => void; note: string; autoFocus?: boolean }) {
  return (
    <>
      <label className="folder-label" htmlFor="project-folder">Project folder<span className="field-note">{note}</span></label>
      <div className="folder-field"><input id="project-folder" value={value} onChange={e => onChange(e.target.value)} placeholder="G:\work\my-app" autoFocus={autoFocus} spellCheck={false} /><button className="icon-btn" type="button" title="Browse project folder" aria-label="Browse project folder" disabled={browsing} onClick={onBrowse}><Ic i={FolderOpen} /></button></div>
    </>
  );
}

// ---------------------------------------------------------------- new project

export function NewProjectDialog({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (id: string) => void; onError: (e: string) => void }) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [maxParallel, setMaxParallel] = useState(3);
  const [start, setStart] = useState(true);
  const [pipeline, setPipeline] = useState<'auto' | 'single' | 'team'>('auto');
  const { browsing, browse } = useFolderPicker(setPath, onError);
  const create = () => api<Project>('POST', '/api/projects', { path, name: name || undefined, goal, start, settings: { maxParallel, pipeline } }).then(p => onCreated(p.id)).catch(e => onError(e.message));
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="New project" onClick={e => e.stopPropagation()}>
        <div className="dialog-head"><h2>New project</h2><button className="icon-btn" onClick={onClose} title="Close"><Ic i={X} /></button></div>
        <FolderField value={path} onChange={setPath} browsing={browsing} onBrowse={browse} note="Absolute path, created if missing" autoFocus />
        <label>Name<span className="field-note">Optional</span><input value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Goal<span className="field-note">Optional when the folder has GOAL.md or docs</span><textarea value={goal} onChange={e => setGoal(e.target.value)} rows={5} placeholder="What should the finished product do" /></label>
        <label>How to build<span className="field-note">Auto: the analyst picks one agent or a team from the docs</span>
          <select value={pipeline} onChange={e => setPipeline(e.target.value as typeof pipeline)}>
            <option value="auto">Auto</option>
            <option value="single">One agent</option>
            <option value="team">Team (parallel)</option>
          </select>
        </label>
        <label>Parallel tasks<input type="number" min={1} max={10} value={maxParallel} onChange={e => setMaxParallel(Number(e.target.value))} /></label>
        <label className="check"><input type="checkbox" checked={start} onChange={e => setStart(e.target.checked)} />Start Plexus right away</label>
        <div className="row end"><button onClick={onClose}>Cancel</button><button className="primary" disabled={!path} onClick={create}>Create project</button></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- edit project

/**
 * Rename a project or point it at another folder. A new name saves at once; a new folder asks first, since only the
 * path changes: the project keeps its tasks, chats and memory, and the wrong folder can break it.
 */
export function EditProjectDialog({ project, onClose, onSaved, onError }: { project: Project; onClose: () => void; onSaved: () => void; onError: (e: string) => void }) {
  const [name, setName] = useState(project.name);
  const [path, setPath] = useState(project.path);
  const [confirming, setConfirming] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const { browsing, browse } = useFolderPicker(setPath, onError);
  const newName = name.trim(), newPath = path.trim();
  const moved = !!newPath && newPath !== project.path;
  const renamed = !!newName && newName !== project.name;

  const save = async () => {
    if (moved && !confirming) { setConfirming(true); setUnderstood(false); return; }
    setBusy(true);
    try {
      if (moved) await api('POST', `/api/projects/${project.id}/folder`, { path: newPath });
      if (renamed) await api('PATCH', `/api/projects/${project.id}`, { name: newName });
      onSaved();
    } catch (e: any) {
      onError(e.message);
      setConfirming(false);
    } finally { setBusy(false); }
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label={confirming ? 'Change the project folder' : 'Edit project'} onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
        {!confirming ? (
          <>
            <div className="dialog-head"><h2>Edit project</h2><button className="icon-btn" onClick={onClose} title="Close"><Ic i={X} /></button></div>
            <label>Name<input value={name} onChange={e => setName(e.target.value)} autoFocus onFocus={e => e.currentTarget.select()}
              onKeyDown={e => { if (e.key === 'Enter' && (renamed || moved)) void save(); }} /></label>
            <FolderField value={path} onChange={setPath} browsing={browsing} onBrowse={browse} note="An existing folder" />
            {project.folderMissing && !moved && <p className="field-hint warn">This folder no longer exists. Choose where the project is now.</p>}
            {moved && <p className="field-hint">Changing the folder asks for confirmation on the next step</p>}
            <div className="row end">
              <button onClick={onClose}>Cancel</button>
              <button className="primary" disabled={busy || (!renamed && !moved) || !newName} onClick={save}>{moved ? 'Continue' : 'Save'}</button>
            </div>
          </>
        ) : (
          <>
            <div className="dialog-head">
              <h2>Change the project folder</h2>
              <button className="icon-btn" onClick={onClose} title="Close"><Ic i={X} /></button>
            </div>
            <dl className="move-paths">
              <dt>From</dt><dd className="mono">{project.path}{project.folderMissing && <span className="move-gone">not found</span>}</dd>
              <dt>To</dt><dd className="mono">{newPath}</dd>
            </dl>
            <ul className="dialog-points">
              <li>This is still the same project. Its tasks, chats, history and settings stay as they are. Only the folder Plexus works in changes.</li>
              <li>{project.folderMissing
                ? 'Memory stays with the project. The old folder is gone, so if the new folder has no .plexus memory of its own, the project continues with its goal and otherwise empty memory.'
                : 'Memory stays with the project. If the new folder has no .plexus memory, it is copied there from the old folder.'}</li>
              <li>To work on a different codebase, create a new project instead.</li>
            </ul>
            <div className="callout warn" role="note">
              The wrong folder can break this project for good. Agents read and change the code in it, and task branches made from the old repository may no longer merge.
            </div>
            <label className="check"><input type="checkbox" checked={understood} onChange={e => setUnderstood(e.target.checked)} autoFocus />I understand that only the folder changes</label>
            <div className="row end">
              <button className="ghost" onClick={() => setConfirming(false)}><Ic i={ArrowLeft} />Back</button>
              <button className="primary" disabled={!understood || busy} onClick={save}>{busy ? 'Changing…' : 'Change folder'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
