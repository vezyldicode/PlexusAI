// How Plexus's work reaches the project folder.
//
// Default (Settings → Advanced → Auto-commit off): Plexus never commits on the user's branches. It integrates on a hidden
// ref, refs/plexus/<project>/base, that task branches start from and merge into (inside Plexus's own integration
// worktree). The project folder is treated as a second branch, refs/plexus/<project>/synced: a commit of the folder as
// Plexus last saw it (uncommitted work included, as a commit object no branch points to).
//
// Reconcile brings the two together with a real three-way git merge: a snapshot of the folder now (child of `synced`)
// is merged with the base, their common ancestor being the last state both had. A clean result becomes the new base and
// is written into the folder as uncommitted edits; the user reviews and commits them. What the user commits, which
// branch is checked out and HEAD do not matter: only the files on disk do. When the folder and Plexus changed the same
// lines, nothing in the folder is touched and the folder's snapshot goes to an integrator task (on a branch of its own)
// that merges the base into it; its merge then lands through the same path. Nothing gets stuck: every reconcile starts
// from the last state both sides had, never from an older one.
//
// Auto-commit on: the earlier behaviour (snapshot commit of uncommitted work, merges committed on the checked-out branch).
import { join } from 'node:path';
import type { Project } from '../shared/types.ts';
import { appConfig } from './config.ts';
import { ensure, paths } from './paths.ts';
import { applyToCheckout, commitAll, ensureRepo, git, gitOk, mergeBranch, mergeDetached, mergeTrees, revParse, sameTree, snapshotCommit } from './util/git.ts';

export const autoCommit = () => appConfig().autoCommit;

const hiddenRef = (p: Project) => `refs/plexus/${p.id}/base`;
const syncedRef = (p: Project) => `refs/plexus/${p.id}/synced`;

/** Branch an integrator resolves "folder vs Plexus" conflicts on. */
export const FOLDER_SYNC_BRANCH = 'plexus/folder-sync';

/** What tasks start from and merge into: the hidden base ref, or the checked-out branch with auto-commit on. */
export const baseRef = (p: Project): string => autoCommit() ? p.mainBranch : hiddenRef(p);

const integrationWorktree = (p: Project) => join(ensure(join(paths.worktrees, p.id)), 'integration');

export interface SyncResult {
  ok: boolean;
  /** Files written into the folder. */
  files: string[];
  /** Files both the folder and Plexus changed in the same place (nothing was written). */
  conflicts: string[];
  /** The folder's snapshot that conflicts with the base: the integrator merges the base into it. */
  folder?: string;
  /** The folder changed again while the result was being written: nothing was written, the next reconcile retries. */
  busy?: boolean;
}

/** Called when the folder and the base conflict, so the orchestrator can hand the snapshot to an integrator. */
type ConflictHandler = (p: Project, r: SyncResult) => void | Promise<void>;
let conflictHandler: ConflictHandler | null = null;
export const onFolderConflict = (h: ConflictHandler | null) => { conflictHandler = h; };

// Every operation on a project's refs and folder runs one at a time (reconcile, merges, coordinator edits).
const locks = new Map<string, Promise<unknown>>();
function serialized<T>(p: Project, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(p.id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(p.id, next.catch(() => {}));
  return next;
}

const SNAP_MSG = 'plexus: project folder (not on any branch)';

/** The folder as a commit: `synced` itself when nothing changed on disk, else a child of it. */
async function folderCommit(p: Project, synced: string): Promise<string> {
  const snap = await snapshotCommit(p.path, synced, SNAP_MSG);
  return await sameTree(p.path, snap, synced) ? synced : snap;
}

async function reconcileNow(p: Project): Promise<SyncResult> {
  const ok: SyncResult = { ok: true, files: [], conflicts: [] };
  const base = await revParse(p.path, hiddenRef(p));
  if (!base) {
    // First use: the folder as it is becomes the base.
    const snap = await snapshotCommit(p.path, await revParse(p.path, 'HEAD'), SNAP_MSG);
    await gitOk(p.path, 'update-ref', hiddenRef(p), snap);
    await gitOk(p.path, 'update-ref', syncedRef(p), snap);
    return ok;
  }
  const synced = await revParse(p.path, syncedRef(p)) ?? base;
  const folder = await folderCommit(p, synced);
  if (folder !== synced) await gitOk(p.path, 'update-ref', syncedRef(p), folder);

  // The merge of the folder and the base (git finds their last common state: what both had).
  let target: string;
  if (await isAncestor(p, folder, base)) target = base;               // the base already has the folder's state
  else if (await isAncestor(p, base, folder)) target = folder;        // only the folder moved
  else {
    const m = await mergeTrees(p.path, base, folder, 'plexus: merge the project folder into the base');
    if (!m.ok) return { ok: false, files: [], conflicts: m.conflicts, folder };
    target = m.commit!;
  }
  if (target !== base) await gitOk(p.path, 'update-ref', hiddenRef(p), target, base);
  if (target === folder) return ok;

  // Write what the folder does not have yet. A file changed on disk since the snapshot is merged line by line or, if
  // that conflicts, nothing is written now (the user is typing): the next reconcile starts from this snapshot.
  const w = await applyToCheckout(p.path, folder, target);
  if (!w.ok) return { ok: false, files: [], conflicts: w.conflicts, busy: true };
  await gitOk(p.path, 'update-ref', syncedRef(p), target);
  return { ok: true, files: w.files, conflicts: [] };
}

const isAncestor = async (p: Project, a: string, b: string) => (await git(p.path, 'merge-base', '--is-ancestor', a, b)).code === 0;

/**
 * Bring the folder and the base together (see the top of this file): the folder's new edits go into the base, Plexus's
 * finished work goes into the folder. A conflict is handed to the conflict handler (an integrator task).
 */
export async function reconcile(p: Project): Promise<SyncResult> {
  if (autoCommit()) return { ok: true, files: [], conflicts: [] };
  const r = await serialized(p, () => reconcileNow(p));
  if (!r.ok && r.folder && conflictHandler) await conflictHandler(p, r);
  return r;
}

/** Back-compat name: write what the base has into the folder (a full reconcile). */
export const syncCheckout = reconcile;

const list = (files: string[]) => `${files.slice(0, 20).join(', ')}${files.length > 20 ? ` (+${files.length - 20} more)` : ''}`;

export const conflictNotice = (r: SyncResult) => r.busy
  ? `Plexus has finished changes for files you are editing right now (${list(r.conflicts)}). Nothing was overwritten; they are written in as soon as those edits settle (next merge, task start or resume).`
  : `Your edits in the project folder and Plexus's finished work change the same lines in: ${list(r.conflicts)}. ` +
    `Nothing in the folder was overwritten. An integrator task merges the two; its result is written into the folder when it finishes. ` +
    `Until then, new tasks start without your edits to those lines.`;

/**
 * Take the folder as it is now into the base tasks start from (before a run, and after the coordinator edited the folder),
 * delivering Plexus's finished work at the same time. Returns a notice for the chat, or '' when there is nothing to say.
 */
export async function absorbCheckout(p: Project): Promise<string> {
  if (autoCommit()) {
    return await commitAll(p.path, 'chore: snapshot before Plexus run') ? 'Committed uncommitted changes in the project before starting.' : '';
  }
  const r = await reconcile(p);
  return r.ok ? '' : conflictNotice(r);
}

/** Before a task's worktree is made: the base takes in the folder as it is now (the user's newest edits). */
export async function ensureBase(p: Project): Promise<void> {
  if (autoCommit()) return;
  await reconcile(p);
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
  const r = await serialized(p, async (): Promise<MergeOutcome & { head?: string }> => {
    if (!await revParse(p.path, hiddenRef(p))) await reconcileNow(p);
    const before = await revParse(p.path, hiddenRef(p));
    if (!before) return { ok: false, conflict: false, detail: 'Plexus could not create its base for this project.' };
    const m = await mergeDetached(p.path, integrationWorktree(p), before, branch, message);
    if (m.ok && m.head) await gitOk(p.path, 'update-ref', hiddenRef(p), m.head, before);
    return m;
  });
  if (!r.ok || !r.head) return r;
  return { ok: r.ok, conflict: r.conflict, detail: r.detail, sync: await reconcile(p) };
}

/** Commits on `rev` since `since` (ISO time), for "did anything change" checks. */
export async function commitsSince(p: Project, since: string): Promise<number> {
  return Number((await git(p.path, 'rev-list', '--count', `--since=${since}`, baseRef(p))).stdout.trim()) || 0;
}
