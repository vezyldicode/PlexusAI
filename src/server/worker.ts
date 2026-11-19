import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentResultSchema, type Account, type AgentResult, type Project, type Task } from '../shared/types.ts';
import { applyClassification, getAccount, runningByAccount } from './accounts.ts';
import { adapterFor, type Classification } from './adapters/index.ts';
import { now } from './db.ts';
import { bus } from './events.ts';
import { ensure, paths } from './paths.ts';
import { buildTaskPrompt, PROGRESS_FILE, RESULT_FILE, TASK_DIR } from './prompts.ts';
import { getRole } from './roles.ts';
import { materializeSkills } from './skills.ts';
import { finishRun, getTask, shortId, startRun, updateTask } from './tasks.ts';
import { addWorktree, commitAll, diffStat, git } from './util/git.ts';

export interface AttemptOutcome {
  outcome: 'success' | 'interrupted' | 'failed';
  result: AgentResult | null;
  classification: Classification;
  reason: string;
}

/** Abort controllers of running attempts, by task id (used by Stop / cancel). */
export const running = new Map<string, AbortController>();

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'task';

/** Does this task produce commits that must be merged? */
export function writesCode(t: Task): boolean {
  if (['architect', 'build', 'fix', 'integrate', 'qa'].includes(t.kind)) return true;
  if (t.kind === 'custom') return getRole(t.role).writesCode;
  return false;
}

/** Create (or reuse) the task's worktree. Returns its path. */
export async function prepareWorktree(p: Project, t: Task): Promise<string> {
  const dir = ensure(join(paths.worktrees, p.id));
  let wt = t.worktree;
  if (writesCode(t)) {
    const branch = t.branch ?? `plexus/${shortId(t)}-${slug(t.title)}`;
    wt = wt ?? join(dir, shortId(t));
    await addWorktree(p.path, wt, { branch, newBranchFrom: p.mainBranch });
    if (!t.branch || !t.worktree) updateTask(t.id, { branch, worktree: wt }, true);
  } else {
    wt = wt ?? join(dir, shortId(t));
    const parent = t.parentId ? getTask(t.parentId) : null;
    const at = t.kind === 'review' && parent?.branch ? parent.branch : p.mainBranch;
    await addWorktree(p.path, wt, { detachAt: at });
    if (!t.worktree) updateTask(t.id, { worktree: wt }, true);
  }
  mkdirSync(join(wt, TASK_DIR), { recursive: true });
  const brief = `# ${shortId(t)}: ${t.title}\n\n${t.description}\n`;
  writeFileSync(join(wt, TASK_DIR, 'brief.md'), brief);
  if (!existsSync(join(wt, PROGRESS_FILE))) writeFileSync(join(wt, PROGRESS_FILE), '');
  return wt;
}

/** Extract the result: result.json in the worktree, else the last ```json block of the final message. */
export function readResult(wt: string, finalText: string): AgentResult | null {
  const candidates: string[] = [];
  const f = join(wt, RESULT_FILE);
  if (existsSync(f)) candidates.push(readFileSync(f, 'utf8'));
  const blocks = [...finalText.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  candidates.push(...blocks.reverse());
  const brace = finalText.lastIndexOf('{"');
  if (brace >= 0) candidates.push(finalText.slice(brace));
  for (const c of candidates) {
    try {
      const parsed = AgentResultSchema.safeParse(JSON.parse(c));
      if (parsed.success) return parsed.data;
    } catch { /* try next */ }
  }
  return null;
}

export async function runAttempt(p: Project, task: Task, account: Account): Promise<AttemptOutcome> {
  const role = getRole(task.role);
  const adapter = adapterFor(account.provider);
  const ctl = new AbortController();
  running.set(task.id, ctl);
  runningByAccount.set(account.id, (runningByAccount.get(account.id) ?? 0) + 1);
  bus.emitEvent('account.updated', null, getAccount(account.id), false);
  updateTask(task.id, { status: 'running', accountId: account.id, lastAccountId: account.id });
  bus.emitEvent('task.started', p.id, { id: task.id, seq: task.seq, title: task.title, account: account.id, provider: account.provider, attempt: task.attempts + 1 });

  const logDir = ensure(join(paths.logs, p.id));
  const logPath = join(logDir, `${shortId(task)}-a${task.attempts + 1}-${account.id}.log`);
  const runId = startRun(task.id, account.id, logPath);
  let wt = '';
  try {
    wt = await prepareWorktree(p, task);
    task = getTask(task.id)!;
    const skills = materializeSkills(wt, role.skills);
    const progress = readFileSync(join(wt, PROGRESS_FILE), 'utf8');
    rmSync(join(wt, RESULT_FILE), { force: true });
    const prompt = buildTaskPrompt(p, task, role, account, progress, skills);
    writeFileSync(logPath, `# prompt (${now()})\n${prompt}\n\n# output\n`);

    const out = await adapter.run({
      account, cwd: wt, prompt, model: task.models?.[account.provider] || role.models[account.provider], readOnly: false,
      timeoutMs: role.maxRuntimeMin * 60_000, idleTimeoutMs: Math.max(10, Math.min(30, role.maxRuntimeMin)) * 60_000,
      logPath, signal: ctl.signal,
      onEvent: e => bus.emitEvent('task.log', p.id, { id: task.id, seq: task.seq, account: account.id, kind: e.kind, text: e.text.slice(0, 2000) }, false),
    });
    applyClassification(account.id, out.classification, out.quota);
    const result = readResult(wt, out.finalText);
    const c = out.classification;
    const accountProblem = ['limited', 'transient', 'needs_login', 'blocked'].includes(c.state);

    let outcome: AttemptOutcome;
    if (out.killedReason === 'aborted') outcome = { outcome: 'interrupted', result: null, classification: c, reason: 'stopped by user' };
    else if (accountProblem && !result) outcome = { outcome: 'interrupted', result: null, classification: c, reason: `account ${account.id} ${c.state}: ${c.evidence.join('; ') || c.reason}` };
    else if (out.killedReason) outcome = { outcome: 'interrupted', result, classification: c, reason: `killed: ${out.killedReason}` };
    else if (!result) outcome = { outcome: 'interrupted', result: null, classification: c, reason: `no result produced (${c.reason}${out.finalText ? ': ' + out.finalText.slice(0, 300) : ''})` };
    else if (result.status === 'failed' || result.status === 'blocked') outcome = { outcome: 'failed', result, classification: c, reason: `${result.status}: ${result.summary}` };
    else outcome = { outcome: 'success', result, classification: c, reason: 'ok' };

    finishRun(runId, outcome.outcome, { ...c, reason: outcome.reason }, out.exitCode);
    if (outcome.outcome !== 'success') await preserveWork(p, task, wt, account, outcome.reason);
    return outcome;
  } catch (e: any) {
    const c: Classification = { state: 'task_error', reason: 'worker_exception', evidence: [String(e?.message ?? e)] };
    finishRun(runId, 'interrupted', c, null);
    if (wt) await preserveWork(p, task, wt, account, `worker error: ${e?.message ?? e}`).catch(() => {});
    return { outcome: 'interrupted', result: null, classification: c, reason: `worker error: ${e?.message ?? e}` };
  } finally {
    running.delete(task.id);
    runningByAccount.set(account.id, Math.max(0, (runningByAccount.get(account.id) ?? 1) - 1));
    bus.emitEvent('account.updated', null, getAccount(account.id), false);
  }
}

/** Handoff support: commit whatever exists and append an interruption note to progress.md. */
async function preserveWork(p: Project, t: Task, wt: string, account: Account, reason: string) {
  if (!existsSync(wt)) return;
  let stat = '';
  if (writesCode(t)) {
    await commitAll(wt, `wip(${shortId(t)}): interrupted on ${account.id} — ${reason.slice(0, 80)}`);
    stat = await diffStat(wt, p.mainBranch);
  }
  const status = (await git(wt, 'status', '--short')).stdout.trim();
  appendFileSync(join(wt, PROGRESS_FILE), `\n\n---\n[plexus ${now()}] Attempt by ${account.id} (${account.provider}) ended: ${reason}\n` +
    (stat ? `Changes on this branch so far:\n${stat}\n` : '') + (status ? `Uncommitted:\n${status}\n` : ''));
}
