import type { AgentResult, Run, Task, TaskKind, TaskStatus, TokenUsage } from '../shared/types.ts';
import { getDb, json, now } from './db.ts';
import { bus } from './events.ts';

function rowToTask(r: any): Task {
  return {
    id: r.id, projectId: r.project_id, seq: r.seq, title: r.title, description: r.description, role: r.role, kind: r.kind,
    status: r.status, deps: json(r.deps, []), parentId: r.parent_id, branch: r.branch, worktree: r.worktree, priority: r.priority,
    attempts: r.attempts, accountId: r.account_id, lastAccountId: r.last_account_id, authorAccountId: r.author_account_id,
    reviewCycles: r.review_cycles, acceptance: json(r.acceptance, []), acIds: json(r.ac_ids, []), result: json<AgentResult | null>(r.result, null), error: r.error,
    models: json(r.models, {}), efforts: json(r.efforts, {}), paths: json(r.paths, []), originSessionId: r.origin_session_id ?? null,
    adhoc: !!r.adhoc, cliSessionId: r.cli_session_id ?? null, cliAccountId: r.cli_account_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export const ACTIVE: TaskStatus[] = ['pending', 'running', 'interrupted', 'in_review'];

export function listTasks(projectId: string): Task[] {
  return (getDb().prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY seq').all(projectId) as any[]).map(rowToTask);
}

export function getTask(id: string): Task | null {
  const r = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return r ? rowToTask(r) : null;
}

/** Resolve a task reference that may be the full id or the short "T12" form. */
export function findTask(projectId: string, ref: string): Task | null {
  return getTask(ref) ?? getTask(`${projectId}-${ref.toUpperCase()}`);
}

/** Repo-relative, forward slashes, no leading ./ or trailing slash; empty and absolute paths dropped. */
export function normPaths(ps: string[]): string[] {
  return [...new Set(ps.map(p => String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(p => p && !p.startsWith('/') && !/^[a-z]:/i.test(p) && !p.split('/').includes('..')))];
}

/** Two path lists overlap when one entry equals or contains another (directory prefix). Globs are cut at the first wildcard. */
export function pathsOverlap(a: string[], b: string[]): boolean {
  const base = (p: string) => p.split(/[*?[{]/)[0].replace(/\/+$/, '');
  return a.some(x => b.some(y => { const p = base(x), q = base(y); return !p || !q || p === q || p.startsWith(q + '/') || q.startsWith(p + '/'); }));
}

/** Upper-cased, de-duplicated acceptance criterion ids ("ac3" → "AC3"). */
export function normAcIds(ids: string[]): string[] {
  return [...new Set(ids.map(i => String(i).trim().toUpperCase()).filter(Boolean))];
}

export const shortId = (t: Pick<Task, 'seq'>) => `T${t.seq}`;

export function createTask(projectId: string, t: {
  title: string; description?: string; role: string; kind: TaskKind; deps?: string[]; parentId?: string | null;
  branch?: string | null; worktree?: string | null; priority?: number; acceptance?: string[]; acIds?: string[]; authorAccountId?: string | null; reviewCycles?: number; paths?: string[];
  /** Chat session this work belongs to; defaults to the parent task's. */
  originSessionId?: string | null;
  adhoc?: boolean; lastAccountId?: string | null;
}): Task {
  const db = getDb();
  const seq = ((db.prepare('SELECT MAX(seq) AS m FROM tasks WHERE project_id = ?').get(projectId) as any)?.m ?? 0) + 1;
  const id = `${projectId}-T${seq}`;
  const parentAc = t.acIds === undefined && t.parentId ? json<string[]>((db.prepare('SELECT ac_ids AS a FROM tasks WHERE id = ?').get(t.parentId) as any)?.a, []) : [];
  const acIds = normAcIds(t.acIds ?? parentAc);
  const origin = t.originSessionId ?? (t.parentId ? (db.prepare('SELECT origin_session_id AS o FROM tasks WHERE id = ?').get(t.parentId) as any)?.o : null) ?? null;
  db.prepare(`INSERT INTO tasks (id, project_id, seq, title, description, role, kind, status, deps, parent_id, branch, worktree, priority,
              acceptance, ac_ids, author_account_id, review_cycles, paths, origin_session_id, adhoc, last_account_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, projectId, seq, t.title, t.description ?? '', t.role, t.kind, JSON.stringify(t.deps ?? []), t.parentId ?? null, t.branch ?? null,
      t.worktree ?? null, t.priority ?? 50, JSON.stringify(t.acceptance ?? []), JSON.stringify(acIds), t.authorAccountId ?? null, t.reviewCycles ?? 0, JSON.stringify(normPaths(t.paths ?? [])), origin, t.adhoc ? 1 : 0, t.lastAccountId ?? null, now(), now());
  const task = getTask(id)!;
  bus.emitEvent('task.created', projectId, { id, seq, title: task.title, role: task.role, kind: task.kind });
  return task;
}

const COLS: Record<string, string> = {
  title: 'title', description: 'description', role: 'role', status: 'status', deps: 'deps', branch: 'branch', worktree: 'worktree',
  priority: 'priority', attempts: 'attempts', accountId: 'account_id', lastAccountId: 'last_account_id', authorAccountId: 'author_account_id',
  reviewCycles: 'review_cycles', result: 'result', error: 'error', acceptance: 'acceptance', acIds: 'ac_ids', models: 'models', efforts: 'efforts', paths: 'paths',
  cliSessionId: 'cli_session_id', cliAccountId: 'cli_account_id',
};

export function updateTask(id: string, patch: Partial<Task>, quiet = false): Task {
  const sets: string[] = [], vals: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = COLS[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    vals.push(Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);
  }
  if (sets.length) getDb().prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now(), id);
  const t = getTask(id)!;
  if (!quiet) bus.emitEvent('task.updated', t.projectId, { id, seq: t.seq, status: t.status, accountId: t.accountId, title: t.title, error: t.error }, 'status' in patch);
  return t;
}

export function setStatus(id: string, status: TaskStatus, extra: Partial<Task> = {}): Task {
  return updateTask(id, { ...extra, status });
}

/** Tasks that can start now: pending/interrupted with all dependencies done. */
export function runnableTasks(projectId: string): Task[] {
  const all = listTasks(projectId);
  const byId = new Map(all.map(t => [t.id, t]));
  return all
    .filter(t => (t.status === 'pending' || t.status === 'interrupted') && t.deps.every(d => byId.get(d)?.status === 'done'))
    .sort((a, b) => b.priority - a.priority || a.seq - b.seq);
}

export function countByStatus(projectId: string): Record<string, number> {
  const rows = getDb().prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status').all(projectId) as any[];
  return Object.fromEntries(rows.map(r => [r.status, r.n]));
}

// ---------------- runs ----------------

export function startRun(taskId: string, accountId: string, logPath: string): number {
  const r = getDb().prepare('INSERT INTO runs (task_id, account_id, started_at, log_path) VALUES (?, ?, ?, ?)').run(taskId, accountId, now(), logPath);
  return Number(r.lastInsertRowid);
}

export function finishRun(id: number, outcome: string, classification: unknown, exitCode: number | null, usage: TokenUsage | null = null): void {
  getDb().prepare('UPDATE runs SET ended_at = ?, outcome = ?, classification = ?, exit_code = ?, usage = ? WHERE id = ?')
    .run(now(), outcome, JSON.stringify(classification), exitCode, JSON.stringify(usage), id);
}

export function listRuns(taskId: string): Run[] {
  return (getDb().prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY id').all(taskId) as any[]).map(r => ({
    id: r.id, taskId: r.task_id, accountId: r.account_id, startedAt: r.started_at, endedAt: r.ended_at, outcome: r.outcome,
    classification: json(r.classification, null), logPath: r.log_path, exitCode: r.exit_code, usage: json<TokenUsage | null>(r.usage, null),
  }));
}
