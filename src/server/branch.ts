// The project's branch follows the branch checked out in its folder. Read from .git/HEAD when the daemon starts, on every
// project load in the UI (a reload), and whenever HEAD changes on disk (git checkout / switch, from any program).
// A detached HEAD or a folder that is not yet a repository keeps the last known branch.
import { readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, resolve } from 'node:path';
import { bus } from './events.ts';
import { getProject, listProjects, updateProject } from './projects.ts';

/** The git dir of a checkout rooted at `path`: `.git` itself, or the one a `.git` file points to (linked worktree). */
function gitDir(path: string): string | null {
  const dot = join(path, '.git');
  try {
    if (statSync(dot).isDirectory()) return dot;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'));
    return m ? resolve(path, m[1].trim()) : null;
  } catch { return null; }
}

/** Branch checked out in `path`, or null (no repository there, or detached HEAD). */
export function headBranch(path: string): string | null {
  const dir = gitDir(path);
  if (!dir) return null;
  try {
    const m = /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(dir, 'HEAD'), 'utf8'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

/** Store the folder's branch on the project when it differs (that emits project.updated, which the UI listens to). */
export function syncBranch(id: string): void {
  const p = getProject(id);
  if (!p) return;
  const b = headBranch(p.path);
  if (b && b !== p.mainBranch) updateProject(id, { mainBranch: b });
}

const watchers = new Map<string, { path: string; w: FSWatcher }>();

export function unwatchBranch(id: string): void {
  watchers.get(id)?.w.close();
  watchers.delete(id);
}

/** Watch the git dir (not the HEAD file: git replaces HEAD by renaming HEAD.lock over it, which ends a file watch). */
function watchBranch(id: string): void {
  const p = getProject(id);
  if (!p) return unwatchBranch(id);
  if (watchers.get(id)?.path === p.path) return;
  unwatchBranch(id);
  const dir = gitDir(p.path);
  if (!dir) return; // no repository yet: the project.updated that follows its creation brings us back here
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    const w = watch(dir, { persistent: false }, (_e, name) => {
      if (name && name !== 'HEAD') return;
      clearTimeout(t);
      t = setTimeout(() => syncBranch(id), 100);
    });
    w.on('error', () => unwatchBranch(id));
    watchers.set(id, { path: p.path, w });
  } catch { /* folder gone or not watchable: reloads still sync */ }
}

const onEvent = (ev: { type: string; projectId: string | null }) => {
  if (ev.projectId && (ev.type === 'project.created' || ev.type === 'project.updated')) watchBranch(ev.projectId);
};

export function startBranchWatch(): void {
  for (const p of listProjects()) { syncBranch(p.id); watchBranch(p.id); }
  bus.on('event', onEvent);
}

export function stopBranchWatch(): void {
  bus.off('event', onEvent);
  for (const id of [...watchers.keys()]) unwatchBranch(id);
}
