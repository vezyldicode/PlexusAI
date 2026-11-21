import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync, type Dirent } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { childEnv } from './proc.ts';
import { appConfig } from '../config.ts';

export interface GitResult { code: number; stdout: string; stderr: string }

export function git(cwd: string, ...args: string[]): Promise<GitResult> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: childEnv('git', { ...process.env, GIT_TERMINAL_PROMPT: '0' }) }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function gitOk(cwd: string, ...args: string[]): Promise<string> {
  const r = await git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Author of Plexus's own commits (Settings → Advanced). Read per commit, so a change applies at once. */
const identity = () => {
  const c = appConfig();
  return ['-c', `user.name=${c.gitName || 'Plexus'}`, '-c', `user.email=${c.gitEmail || 'plexus@localhost'}`];
};

/**
 * Make sure `dir` is the root of a git repo; returns the checked-out branch name. With auto-commit on (Settings →
 * Advanced) a repo without commits also gets an initial commit; otherwise Plexus never commits there.
 */
export async function ensureRepo(dir: string): Promise<string> {
  // The project folder must be the root of its own repo. If it merely sits inside another repo
  // (e.g. a folder inside some other checkout), give it its own repository instead of committing to the parent.
  const top = await git(dir, 'rev-parse', '--show-toplevel');
  const norm = (s: string) => resolve(s.trim()).toLowerCase().replace(/[\\/]+$/, '');
  if (top.code !== 0 || norm(top.stdout) !== norm(dir)) await gitOk(dir, 'init', '-b', 'main');
  addExcludes(dir, ['.plexus/', '.plexus-task/', '.claude/skills/', '.agents/skills/']);
  if (appConfig().autoCommit && (await git(dir, 'rev-parse', '--verify', 'HEAD')).code !== 0) {
    await gitOk(dir, 'add', '-A');
    await gitOk(dir, ...identity(), 'commit', '--allow-empty', '-m', 'chore: initial commit (plexus)');
  }
  return currentBranch(dir);
}

/** Ignore plexus-internal paths in every worktree without touching the project's .gitignore. */
export function addExcludes(repo: string, patterns: string[]) {
  const commonDir = join(repo, '.git');
  if (!existsSync(commonDir)) return;
  const file = join(commonDir, 'info', 'exclude');
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const missing = patterns.filter(p => !cur.split(/\r?\n/).includes(p));
  if (missing.length) appendFileSync(file, (cur.endsWith('\n') || !cur ? '' : '\n') + '# plexus\n' + missing.join('\n') + '\n');
}

export async function addWorktree(repo: string, path: string, opts: { branch?: string; newBranchFrom?: string; detachAt?: string }): Promise<void> {
  if (existsSync(path)) return;
  if (opts.detachAt) await gitOk(repo, 'worktree', 'add', '--detach', path, opts.detachAt);
  else if (opts.newBranchFrom) {
    const exists = (await git(repo, 'rev-parse', '--verify', `refs/heads/${opts.branch}`)).code === 0;
    if (exists) await gitOk(repo, 'worktree', 'add', path, opts.branch!);
    else await gitOk(repo, 'worktree', 'add', '-b', opts.branch!, path, opts.newBranchFrom);
  } else await gitOk(repo, 'worktree', 'add', path, opts.branch!);
}

/**
 * Remove the links (symlinks, Windows junctions) inside a folder, without touching what they point to. An agent that
 * linked `node_modules` to the project's own copy would otherwise have that copy emptied when its worktree is deleted:
 * a recursive delete follows a junction on Windows.
 */
export function unlinkLinks(dir: string, depth = 4): void {
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) {
      try { unlinkSync(p); } catch { try { rmdirSync(p); } catch { /* left for git */ } }
    } else if (st.isDirectory() && depth > 0 && e.name !== 'node_modules') unlinkLinks(p, depth - 1);
  }
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  if (existsSync(path)) unlinkLinks(path);
  await git(repo, 'worktree', 'remove', '--force', path);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await git(repo, 'worktree', 'prune');
}

/** Commit everything in a worktree (used to preserve work on interruption). Returns true if a commit was made. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, 'add', '-A');
  const st = await git(cwd, 'diff', '--cached', '--quiet');
  if (st.code === 0) return false;
  const r = await git(cwd, ...identity(), 'commit', '--no-verify', '-m', message);
  return r.code === 0;
}

export async function diffStat(cwd: string, base: string): Promise<string> {
  const r = await git(cwd, 'diff', '--stat', `${base}...HEAD`);
  return r.stdout.trim();
}

/** Lines added + deleted on `branch` since it left `base` (binary files count as 0). */
export async function changedLines(repo: string, base: string, branch: string): Promise<number> {
  const r = await git(repo, 'diff', '--numstat', `${base}...${branch}`);
  return r.stdout.split('\n').reduce((n, l) => {
    const [a, d] = l.split('\t');
    return n + (Number(a) || 0) + (Number(d) || 0);
  }, 0);
}

export async function hasCommitsAhead(repo: string, branch: string, base: string): Promise<boolean> {
  const r = await git(repo, 'rev-list', '--count', `${base}..${branch}`);
  return Number(r.stdout.trim()) > 0;
}

/** Merge a task branch into the main branch inside the main checkout. */
export async function mergeBranch(repo: string, mainBranch: string, branch: string, message: string): Promise<{ ok: boolean; conflict: boolean; detail: string }> {
  const cur = await gitOk(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (cur !== mainBranch) {
    const co = await git(repo, 'checkout', mainBranch);
    if (co.code !== 0) return { ok: false, conflict: false, detail: `cannot checkout ${mainBranch}: ${co.stderr}` };
  }
  const r = await git(repo, ...identity(), 'merge', '--no-ff', '--no-edit', '-m', message, branch);
  if (r.code === 0) return { ok: true, conflict: false, detail: r.stdout };
  const conflict = /CONFLICT|Automatic merge failed/i.test(r.stdout + r.stderr);
  await git(repo, 'merge', '--abort');
  return { ok: false, conflict, detail: (r.stdout + r.stderr).slice(0, 2000) };
}

// ---------------- working without commits on the user's branches ----------------
// Plexus integrates on a hidden ref (refs/plexus/<project>/base): task branches start from it and merge into it, in a
// worktree of its own. The user's checkout only ever receives the resulting changes as uncommitted edits.

function gitBuf(cwd: string, args: string[], env?: Record<string, string>): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: 'buffer', env: childEnv('git', { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }) }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, stdout: stdout as Buffer, stderr: String(stderr) });
    });
  });
}

/** Commit id of `rev`, or null when it does not exist. */
export async function revParse(repo: string, rev: string): Promise<string | null> {
  const r = await git(repo, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Name of the checked-out branch (also on a branch with no commits yet); 'HEAD' when detached. */
export async function currentBranch(repo: string): Promise<string> {
  const r = await git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  return r.code === 0 ? r.stdout.trim() : 'HEAD';
}

/**
 * A commit object of the checkout exactly as it is on disk (tracked and untracked files, minus ignored ones), made with a
 * temporary index: HEAD, the real index and every branch stay as they are. Reachable only from the ref the caller sets.
 */
export async function snapshotCommit(repo: string, parent: string | null, message: string): Promise<string> {
  const idx = resolve(repo, (await gitOk(repo, 'rev-parse', '--git-path', `plexus-index-${process.pid}`)));
  const env = { GIT_INDEX_FILE: idx };
  try {
    if (parent) await gitBuf(repo, ['read-tree', parent], env); // only speeds up hashing of unchanged files
    const add = await gitBuf(repo, ['add', '-A', '--', '.'], env);
    if (add.code !== 0) throw new Error(`git add (snapshot) failed: ${add.stderr}`);
    const tree = await gitBuf(repo, ['write-tree'], env);
    if (tree.code !== 0) throw new Error(`git write-tree failed: ${tree.stderr}`);
    return gitOk(repo, ...identity(), 'commit-tree', tree.stdout.toString().trim(), ...(parent ? ['-p', parent] : []), '-m', message);
  } finally { rmSync(idx, { force: true }); }
}

export const sameTree = async (repo: string, a: string, b: string) =>
  (await git(repo, 'rev-parse', `${a}^{tree}`)).stdout.trim() === (await git(repo, 'rev-parse', `${b}^{tree}`)).stdout.trim();

/** Blob id of `path` in commit `rev`, or null when the file is not there. */
async function blobAt(repo: string, rev: string, path: string): Promise<string | null> {
  const r = await git(repo, 'rev-parse', '--verify', '--quiet', `${rev}:${path}`);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Blob id the file on disk would get (clean filters and line-ending conversion applied), or null when it is missing. */
async function blobOnDisk(repo: string, path: string): Promise<string | null> {
  if (!existsSync(join(repo, path))) return null;
  const r = await git(repo, 'hash-object', '--path', path, '--', path);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Bring the changes `from..to` into the files of the checkout, without touching HEAD, the index or any branch.
 * A file is written when it is still exactly as in `from` on disk (or already as in `to`). A file the user changed too is
 * merged line by line (their edits and Plexus's, as `git merge-file` does); only when that leaves conflicting hunks is
 * nothing written at all and the files are returned, so the user's edits are never overwritten.
 */
export async function applyToCheckout(repo: string, from: string, to: string): Promise<{ ok: boolean; files: string[]; conflicts: string[] }> {
  const r = await gitBuf(repo, ['diff', '--name-only', '--no-renames', '-z', from, to]);
  if (r.code !== 0) throw new Error(`git diff failed: ${r.stderr}`);
  const files = r.stdout.toString('utf8').split('\0').filter(Boolean);
  const writes: { path: string; blob: string | null; merged?: Buffer }[] = [];
  const conflicts: string[] = [];
  for (const path of files) {
    const [before, after, disk] = await Promise.all([blobAt(repo, from, path), blobAt(repo, to, path), blobOnDisk(repo, path)]);
    if (disk === after) continue;
    if (disk === before) { writes.push({ path, blob: after }); continue; }
    const merged = before && after && disk ? await mergeFile(repo, from, to, path) : null;
    if (merged) writes.push({ path, blob: after, merged });
    else conflicts.push(path);
  }
  if (conflicts.length) return { ok: false, files, conflicts };
  for (const w of writes) {
    const abs = join(repo, w.path);
    if (w.blob === null) { rmSync(abs, { force: true }); continue; }
    if (w.merged) { writeFileSync(abs, w.merged); continue; }
    // As it would be checked out: smudge filters and the repository's line endings applied.
    const c = await gitBuf(repo, ['cat-file', '--filters', `${to}:${w.path}`]);
    if (c.code !== 0) throw new Error(`git cat-file ${w.path} failed: ${c.stderr}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, c.stdout);
  }
  return { ok: true, files, conflicts };
}

/** Three-way merge of the file on disk with the change `from..to` to it; null when hunks conflict (or it is binary). */
async function mergeFile(repo: string, from: string, to: string, path: string): Promise<Buffer | null> {
  const [base, theirs] = await Promise.all([
    gitBuf(repo, ['cat-file', '--filters', `${from}:${path}`]), gitBuf(repo, ['cat-file', '--filters', `${to}:${path}`]),
  ]);
  if (base.code !== 0 || theirs.code !== 0) return null;
  const tmp = mkdtempSync(join(tmpdir(), 'plexus-merge-'));
  try {
    const ours = readFileSync(join(repo, path));
    if ([ours, base.stdout, theirs.stdout].some(b => b.includes(0))) return null; // binary
    // Merge with LF everywhere (the disk and git's checkout form may differ in line endings), then keep the disk's style.
    const lf = (b: Buffer) => b.toString('utf8').replace(/\r\n/g, '\n');
    const f = (n: string, b: Buffer) => { const p = join(tmp, n); writeFileSync(p, lf(b)); return p; };
    const m = await gitBuf(repo, ['merge-file', '-p', f('ours', ours), f('base', base.stdout), f('theirs', theirs.stdout)]);
    if (m.code !== 0) return null;
    const crlf = ours.includes('\r\n');
    return Buffer.from(crlf ? m.stdout.toString('utf8').replace(/\n/g, '\r\n') : m.stdout.toString('utf8'), 'utf8');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Merge `branch` into the commit `base` inside Plexus's own integration worktree (detached HEAD), never in the user's
 * checkout. Returns the merge commit; the caller moves its hidden ref there.
 */
export async function mergeDetached(repo: string, wt: string, base: string, branch: string, message: string): Promise<{ ok: boolean; conflict: boolean; detail: string; head?: string }> {
  if (!existsSync(wt)) await addWorktree(repo, wt, { detachAt: base });
  else {
    await git(wt, 'merge', '--abort');
    const co = await git(wt, 'checkout', '--force', '--detach', base);
    if (co.code !== 0) return { ok: false, conflict: false, detail: `cannot prepare the integration worktree: ${co.stderr}` };
    await git(wt, 'clean', '-fdq');
  }
  const r = await git(wt, ...identity(), 'merge', '--no-ff', '--no-edit', '-m', message, branch);
  if (r.code === 0) return { ok: true, conflict: false, detail: r.stdout, head: await gitOk(wt, 'rev-parse', 'HEAD') };
  const conflict = /CONFLICT|Automatic merge failed/i.test(r.stdout + r.stderr);
  await git(wt, 'merge', '--abort');
  return { ok: false, conflict, detail: (r.stdout + r.stderr).slice(0, 2000) };
}
