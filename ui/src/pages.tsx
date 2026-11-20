import { useState } from 'react';
import { X } from 'lucide-react';
import { api } from './api.ts';
import type { Project } from './types.ts';
import { Ic } from './ui.tsx';

// ---------------------------------------------------------------- new project

export function NewProjectDialog({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (id: string) => void; onError: (e: string) => void }) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [maxParallel, setMaxParallel] = useState(3);
  const [start, setStart] = useState(true);
  const [pipeline, setPipeline] = useState<'auto' | 'single' | 'team'>('auto');
  const create = () => api<Project>('POST', '/api/projects', { path, name: name || undefined, goal, start, settings: { maxParallel, pipeline } }).then(p => onCreated(p.id)).catch(e => onError(e.message));
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="New project" onClick={e => e.stopPropagation()}>
        <div className="dialog-head"><h2>New project</h2><button className="icon-btn" onClick={onClose} title="Close"><Ic i={X} /></button></div>
        <label>Project folder<span className="field-note">Absolute path, created if missing</span><input value={path} onChange={e => setPath(e.target.value)} placeholder="G:\work\my-app" autoFocus /></label>
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
