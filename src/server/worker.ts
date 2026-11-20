import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentResultSchema, type Account, type AgentResult, type Project, type Task } from '../shared/types.ts';
import { applyClassification, getAccount, runningByAccount } from './accounts.ts';
import { adapterFor, type Classification } from './adapters/index.ts';
import { getDb, now } from './db.ts';
import { effortForRun } from './models.ts';
import { bus } from './events.ts';
import { ensure, paths } from './paths.ts';
import { writeContextFiles } from './context.ts';
import { buildResumePrompt, buildTaskPrompt, PROGRESS_FILE, RESULT_FILE, TASK_DIR } from './prompts.ts';
import { getRole } from './roles.ts';
import { materializeSkills } from './skills.ts';
import { finishRun, getTask, shortId, startRun, updateTask } from './tasks.ts';
import { addUsage } from './usage.ts';
import { addWorktree, commitAll, diffStat, ensureRepo, git } from './util/git.ts';
import { postMessage, updateProject } from './projects.ts';

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
  if (['architect', 'build', 'fix', 'integrate', 'qa', 'solo'].includes(t.kind)) return true;
  if (t.kind === 'compact') return false;
  if (t.kind === 'custom') return getRole(t.role).writesCode;
  return false;
}

/** What startProject does to the project folder (own repository, snapshot of uncommitted work), for chat requests. */
async function prepareRepo(p: Project): Promise<Project> {
  const main = await ensureRepo(p.path);
  if (await commitAll(p.path, 'chore: snapshot before Plexus run')) postMessage(p.id, 'system', 'Committed uncommitted changes in the project before starting.');
  return updateProject(p.id, { mainBranch: main });
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
  writeContextFiles(p, wt);
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
    if (task.adhoc && p.phase === 'new') p = await prepareRepo(p); // a chat request before the project was ever started
    wt = await prepareWorktree(p, task);
    task = getTask(task.id)!;
    const skills = materializeSkills(wt, role.skills);
    const progress = readFileSync(join(wt, PROGRESS_FILE), 'utf8');
    rmSync(join(wt, RESULT_FILE), { force: true });
    const prov = account.provider;
    // A single-agent task runs on the coordinator's model/effort (a strong model) unless the task overrides it.
    const model = task.models?.[prov] || (task.kind === 'solo' ? p.settings.coordinatorModels?.[prov] : undefined) || role.models[prov];
    const eff = await effortForRun(account, model, task.efforts?.[prov] || (task.kind === 'solo' ? p.settings.coordinatorEfforts?.[prov] : undefined) || role.efforts?.[prov]);
    if (eff.warning) bus.emitEvent('task.log', p.id, { id: task.id, seq: task.seq, account: account.id, kind: 'status', text: eff.warning }, false);

    const run = (prompt: string, resumeId: string | undefined, note: string) => {
      appendFileSync(logPath, `# prompt${resumeId ? ` (resuming ${resumeId})` : ''} (${now()})
${prompt}

# output
${note}`);
      return adapter.run({
        account, cwd: wt, prompt, model, effort: eff.effort, readOnly: false, resumeId,
        timeoutMs: role.maxRuntimeMin * 60_000, idleTimeoutMs: Math.max(10, Math.min(30, role.maxRuntimeMin)) * 60_000,
        logPath, signal: ctl.signal,
        onEvent: e => bus.emitEvent('task.log', p.id, { id: task.id, seq: task.seq, account: account.id, kind: e.kind, text: e.text.slice(0, 2000) }, false),
      });
    };
    writeFileSync(logPath, '');
    const warn = eff.warning ? `[plexus] ${eff.warning}
` : '';
    const resumeId = resumableSession(p, task, account);
    const started = Date.now();
    let out = resumeId ? await run(buildResumePrompt(p, task, role, progress), resumeId, warn) : await run(buildTaskPrompt(p, task, role, account, progress, skills), undefined, warn);
    // The CLI no longer knows the conversation (purged, other machine...): start cold, in the same attempt.
    if (resumeId && !out.killedReason && out.classification.state === 'task_error' && Date.now() - started < 90_000 && !readResult(wt, out.finalText)) {
      const failed = out.usage;
      out = await run(buildTaskPrompt(p, task, role, account, progress, skills), undefined, `[plexus] resuming ${resumeId} failed; starting a new conversation
`);
      out.usage = addUsage(failed, out.usage); // the failed resume spent tokens too
    }
    if (out.sessionId) updateTask(task.id, { cliSessionId: out.sessionId, cliAccountId: account.id }, true);
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

    finishRun(runId, outcome.outcome, { ...c, reason: outcome.reason }, out.exitCode, out.usage);
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

/**
 * CLI conversation this attempt can continue: the task's own (a retry on the same account), else the latest one held
 * by another task in the same worktree on this account (a fix or merge after the author's build). Only that account's
 * CLI home has the conversation, and Claude finds it by working directory, so both must match.
 */
export function resumableSession(p: Project, t: Task, account: Account): string | undefined {
  if (!p.settings.resumeSessions) return undefined;
  if (t.cliSessionId && t.cliAccountId === account.id) return t.cliSessionId;
  if (!t.worktree || !writesCode(t)) return undefined;
  const r = getDb().prepare(`SELECT cli_session_id AS s FROM tasks WHERE project_id = ? AND worktree = ? AND cli_account_id = ? AND cli_session_id IS NOT NULL AND id != ?
                             ORDER BY updated_at DESC LIMIT 1`).get(p.id, t.worktree, account.id, t.id) as any;
  return r?.s ?? undefined;
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
