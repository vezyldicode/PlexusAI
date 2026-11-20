// How Plexus's work reaches the project folder.
//
// Default (Settings → Advanced → Auto-commit off): Plexus never commits on the user's branches. It integrates on a hidden
// ref, refs/plexus/<project>/base: before a run that ref takes the folder as it is on disk (uncommitted work included, as
// a commit object no branch points to), task branches start from it, and merges happen on it inside Plexus's own
// integration worktree. After every merge the new changes are written into the folder as uncommitted edits; the user
// reviews and commits them. refs/plexus/<project>/synced records how far the folder has received them, so a change the
// user is editing at the same time is reported instead of overwritten, and retried later.
//
// Auto-commit on: the earlier behaviour (snapshot commit of uncommitted work, merges committed on the checked-out branch).
import { join } from 'node:path';
import type { Project } from '../shared/types.ts';
import { appConfig } from './config.ts';
import { ensure, paths } from './paths.ts';
import { applyToCheckout, commitAll, ensureRepo, git, gitOk, mergeBranch, mergeDetached, revParse, sameTree, snapshotCommit } from './util/git.ts';

export const autoCommit = () => appConfig().autoCommit;

const hiddenRef = (p: Project) => `refs/plexus/${p.id}/base`;
const syncedRef = (p: Project) => `refs/plexus/${p.id}/synced`;

/** What tasks start from and merge into: the hidden base ref, or the checked-out branch with auto-commit on. */
export const baseRef = (p: Project): string => autoCommit() ? p.mainBranch : hiddenRef(p);

const integrationWorktree = (p: Project) => join(ensure(join(paths.worktrees, p.id)), 'integration');

export interface SyncResult { ok: boolean; files: string[]; conflicts: string[] }

/** Write what the base has and the folder has not received yet into the folder (uncommitted). */
export async function syncCheckout(p: Project): Promise<SyncResult> {
  if (autoCommit()) return { ok: true, files: [], conflicts: [] };
  const base = await revParse(p.path, hiddenRef(p));
  const synced = await revParse(p.path, syncedRef(p));
  if (!base || !synced || base === synced) return { ok: true, files: [], conflicts: [] };
  const r = await applyToCheckout(p.path, synced, base);
  if (r.ok) await gitOk(p.path, 'update-ref', syncedRef(p), base);
  return r;
}

export const conflictNotice = (r: SyncResult) =>
  `Plexus has finished changes it could not write into the project folder, because these files were changed there in the meantime: ` +
  `${r.conflicts.slice(0, 20).join(', ')}${r.conflicts.length > 20 ? ` (+${r.conflicts.length - 20} more)` : ''}. ` +
  `Nothing was overwritten. Commit, stash or undo your edits to those files; Plexus tries again after the next merge and when the project is resumed.`;

/**
 * Take the folder as it is now as the base tasks start from (before a run, and after the coordinator edited the folder).
 * Returns a notice for the chat, or '' when there is nothing to say.
 */
export async function absorbCheckout(p: Project): Promise<string> {
  if (autoCommit()) {
    return await commitAll(p.path, 'chore: snapshot before Plexus run') ? 'Committed uncommitted changes in the project before starting.' : '';
  }
  const base = await revParse(p.path, hiddenRef(p));
  if (base) {
    // Changes the folder has not received yet would be lost by taking the folder as the new base: deliver them first.
    const s = await syncCheckout(p);
    if (!s.ok) return conflictNotice(s) + ' Until then, new tasks start from Plexus\'s own copy, without your newest edits.';
  }
  const parent = base ?? await revParse(p.path, 'HEAD');
  const snap = await snapshotCommit(p.path, parent, 'plexus: project folder as it was before the run (not on any branch)');
  if (base && await sameTree(p.path, snap, base)) return '';
  await gitOk(p.path, 'update-ref', hiddenRef(p), snap);
  await gitOk(p.path, 'update-ref', syncedRef(p), snap);
  return '';
}

/** A project started before the hidden base existed (or a fresh clone of the data folder) gets one on first use. */
export async function ensureBase(p: Project): Promise<void> {
  if (autoCommit() || await revParse(p.path, hiddenRef(p))) return;
  await absorbCheckout(p);
}

/** The repository part of starting work in a project: own repo, branch name, base taken from the folder. */
export async function prepareProjectRepo(p: Project): Promise<{ mainBranch: string; notice: string }> {
  const mainBranch = await ensureRepo(p.path);
  return { mainBranch, notice: await absorbCheckout({ ...p, mainBranch }) };
}

export interface MergeOutcome { ok: boolean; conflict: boolean; detail: string; sync?: SyncResult }

/** Merge a task (or coordinator) branch into the base, then deliver the result to the folder. Callers serialize merges. */
export async function mergeIntoBase(p: Project, branch: string, message: string): Promise<MergeOutcome> {
  if (autoCommit()) return mergeBranch(p.path, p.mainBranch, branch, message);
  await ensureBase(p);
  const before = await revParse(p.path, hiddenRef(p));
  if (!before) return { ok: false, conflict: false, detail: 'Plexus could not create its base for this project.' };
  const r = await mergeDetached(p.path, integrationWorktree(p), before, branch, message);
  if (!r.ok || !r.head) return r;
  await gitOk(p.path, 'update-ref', hiddenRef(p), r.head, before);
  return { ...r, sync: await syncCheckout(p) };
}

/** Commits on `rev` since `since` (ISO time), for "did anything change" checks. */
export async function commitsSince(p: Project, since: string): Promise<number> {
  return Number((await git(p.path, 'rev-list', '--count', `--since=${since}`, baseRef(p))).stdout.trim()) || 0;
}
