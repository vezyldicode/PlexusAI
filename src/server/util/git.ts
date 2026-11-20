import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { childEnv } from './proc.ts';

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

const IDENTITY = ['-c', 'user.name=Plexus', '-c', 'user.email=plexus@localhost'];

/** Make sure `dir` is a git repo with at least one commit; returns the main branch name. */
export async function ensureRepo(dir: string): Promise<string> {
  // The project folder must be the root of its own repo. If it merely sits inside another repo
  // (e.g. a folder inside some other checkout), give it its own repository instead of committing to the parent.
  const top = await git(dir, 'rev-parse', '--show-toplevel');
  const norm = (s: string) => resolve(s.trim()).toLowerCase().replace(/[\\/]+$/, '');
  if (top.code !== 0 || norm(top.stdout) !== norm(dir)) await gitOk(dir, 'init', '-b', 'main');
  if ((await git(dir, 'rev-parse', '--verify', 'HEAD')).code !== 0) {
    await gitOk(dir, 'add', '-A');
    await gitOk(dir, ...IDENTITY, 'commit', '--allow-empty', '-m', 'chore: initial commit (plexus)');
  }
  addExcludes(dir, ['.plexus/', '.plexus-task/', '.claude/skills/', '.agents/skills/']);
  return gitOk(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
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

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, 'worktree', 'remove', '--force', path);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await git(repo, 'worktree', 'prune');
}

/** Commit everything in a worktree (used to preserve work on interruption). Returns true if a commit was made. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, 'add', '-A');
  const st = await git(cwd, 'diff', '--cached', '--quiet');
  if (st.code === 0) return false;
  const r = await git(cwd, ...IDENTITY, 'commit', '--no-verify', '-m', message);
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
  const r = await git(repo, ...IDENTITY, 'merge', '--no-ff', '--no-edit', '-m', message, branch);
  if (r.code === 0) return { ok: true, conflict: false, detail: r.stdout };
  const conflict = /CONFLICT|Automatic merge failed/i.test(r.stdout + r.stderr);
  await git(repo, 'merge', '--abort');
  return { ok: false, conflict, detail: (r.stdout + r.stderr).slice(0, 2000) };
}
