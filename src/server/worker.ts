import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentResultSchema, type Account, type AgentResult, type Project, type Provider, type Role, type Task, type TaskModelInfo } from '../shared/types.ts';
import { applyClassification, getAccount, listAccounts, runningByAccount } from './accounts.ts';
import { adapterFor, type Classification } from './adapters/index.ts';
import { getDb, now } from './db.ts';
import { effortForRun } from './models.ts';
import { bus } from './events.ts';
import { ensure, paths } from './paths.ts';
import { writeContextFiles } from './context.ts';
import { buildResumePrompt, buildTaskParts, PROGRESS_FILE, RESULT_FILE, TASK_DIR } from './prompts.ts';
import { getRole } from './roles.ts';
import { materializeSkills } from './skills.ts';
import { finishRun, getTask, listRuns, setRunModel, shortId, startRun, updateTask } from './tasks.ts';
import { addUsage } from './usage.ts';
import { addWorktree, commitAll, diffStat, ensureRepo, git } from './util/git.ts';
import { postMessage, updateProject, writeHandoff } from './projects.ts';

/**
 * Resume a CLI conversation only while that is cheaper than a fresh start with the hand-off notes: every later call
 * re-reads the whole conversation. Past LANE_CTX_MAX tokens a fresh start wins; past LANE_IDLE_MAX the provider's prompt
 * cache has expired (Claude keeps it 1 h), so only a small conversation is still worth resuming.
 */
export const LANE_CTX_MAX = 120_000;
export const LANE_IDLE_MAX_MS = 55 * 60_000;
const LANE_COLD_CTX_MAX = 40_000;

type From = TaskModelInfo['modelFrom'];

/** Model and effort a task runs with on a provider: its own override, the coordinator's (single-agent work), the role's. */
export function taskModelChoice(p: Project, t: Task, role: Role, prov: Provider): { model: string | undefined; effort: string | undefined; modelFrom: From; effortFrom: From } {
  const solo = t.kind === 'solo';
  const pick = (own: string | undefined, coord: string | undefined, fromRole: string | undefined): [string | undefined, From] =>
    own ? [own, 'task'] : solo && coord ? [coord, 'coordinator'] : fromRole ? [fromRole, 'role'] : [undefined, 'default'];
  const [model, modelFrom] = pick(t.models?.[prov], p.settings.coordinatorModels?.[prov], role.models[prov]);
  const [effort, effortFrom] = pick(t.efforts?.[prov], p.settings.coordinatorEfforts?.[prov], role.efforts?.[prov]);
  return { model, effort, modelFrom, effortFrom };
}

/** What the UI shows for a task's model: the provider it runs (or would run) on, the choice and the last run. */
export function taskModelInfo(p: Project, t: Task): TaskModelInfo {
  const role = getRole(t.role);
  const accounts = listAccounts();
  const acct = accounts.find(a => a.id === (t.accountId ?? t.lastAccountId ?? t.pinnedAccountId ?? t.cliAccountId));
  const usable = new Set(accounts.filter(a => a.enabled).map(a => a.provider));
  const provider: Provider = acct?.provider ?? role.providers.find(x => usable.has(x)) ?? accounts.find(a => a.enabled)?.provider ?? role.providers[0] ?? 'claude';
  const c = taskModelChoice(p, t, role, provider);
  const last = listRuns(t.id).at(-1);
  const reported = last?.usage ? Object.entries(last.usage.byModel).sort((a, b) => (b[1].input + b[1].cacheRead + b[1].output) - (a[1].input + a[1].cacheRead + a[1].output))[0]?.[0] ?? null : null;
  return {
    provider, model: c.model ?? null, effort: c.effort ?? null, modelFrom: c.modelFrom, effortFrom: c.effortFrom,
    ran: last ? { model: last.model ?? null, effort: last.effort ?? null, reported, running: !last.endedAt } : null,
    editable: t.status !== 'running',
  };
}

export function resumeWorthIt(ctx: number, usedAt: string | null): boolean {
  if (ctx > LANE_CTX_MAX) return false;
  const idle = usedAt ? Date.now() - Date.parse(usedAt) : 0;
  return idle <= LANE_IDLE_MAX_MS || ctx <= LANE_COLD_CTX_MAX;
}

export interface AttemptOutcome {
  /** `blocked`: the agent cannot go on without the user; the task waits instead of being retried as it is. */
  outcome: 'success' | 'interrupted' | 'failed' | 'blocked';
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
  const blocks = [...finalText.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1]).reverse();
  if (existsSync(f)) {
    const text = readFileSync(f, 'utf8');
    // A file written through a non-UTF-8 code page (Windows PowerShell) has "??" where letters were: prefer the reply's copy.
    const mangled = /\?\?/.test(text) && blocks.length > 0 && !/\?\?/.test(blocks[0]);
    if (mangled) candidates.push(...blocks, text); else candidates.push(text, ...blocks);
  } else candidates.push(...blocks);
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
  // One log per run: an interrupted run and the next one of the same attempt must not share (and overwrite) a file.
  const logPath = join(logDir, `${shortId(task)}-r${listRuns(task.id).length + 1}-${account.id}.log`);
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
    const choice = taskModelChoice(p, task, role, prov);
    const model = choice.model;
    const eff = await effortForRun(account, model, choice.effort);
    setRunModel(runId, model ?? null, eff.effort ?? null);
    if (eff.warning) bus.emitEvent('task.log', p.id, { id: task.id, seq: task.seq, account: account.id, kind: 'status', text: eff.warning }, false);

    const run = (prompt: string, resumeId: string | undefined, note: string, system?: string) => {
      appendFileSync(logPath, `# prompt${resumeId ? ` (resuming ${resumeId})` : ''} (${now()})
${system ? `${system}\n\n` : ''}${prompt}

# output
${note}`);
      return adapter.run({
        account, cwd: wt, prompt, system, model, effort: eff.effort, readOnly: false, resumeId, autocompact: p.settings.autocompactTokens,
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
    const cold = () => buildTaskParts(p, task, role, account, progress, skills);
    // Messages for the agent are delivered with this run's prompt, once.
    const delivered = task.inbox.length;
    let out: Awaited<ReturnType<typeof run>>;
    if (resumeId) out = await run(buildResumePrompt(p, task, role, progress), resumeId, warn);
    else { const c = cold(); out = await run(c.prompt, undefined, warn, c.system); }
    if (delivered) updateTask(task.id, { inbox: getTask(task.id)!.inbox.slice(delivered) }, true);
    // The CLI no longer knows the conversation (purged, other machine...): start cold, in the same attempt.
    if (resumeId && !out.killedReason && out.classification.state === 'task_error' && Date.now() - started < 90_000 && !readResult(wt, out.finalText)) {
      const failed = out.usage;
      const c = cold();
      out = await run(c.prompt, undefined, `[plexus] resuming ${resumeId} failed; starting a new conversation
`, c.system);
      out.usage = addUsage(failed, out.usage); // the failed resume spent tokens too
    }
    if (out.sessionId) updateTask(task.id, { cliSessionId: out.sessionId, cliAccountId: account.id, cliCtxTokens: out.usage?.lastCtx ?? 0, cliUsedAt: now() }, true);
    applyClassification(account.id, out.classification, out.quota);
    const result = readResult(wt, out.finalText);
    const c = out.classification;
    const accountProblem = ['limited', 'transient', 'needs_login', 'blocked'].includes(c.state);

    let outcome: AttemptOutcome;
    if (out.killedReason === 'aborted') outcome = { outcome: 'interrupted', result: null, classification: c, reason: 'stopped by user' };
    else if (accountProblem && !result) outcome = { outcome: 'interrupted', result: null, classification: c, reason: `account ${account.id} ${c.state}: ${c.evidence.join('; ') || c.reason}` };
    else if (out.killedReason) outcome = { outcome: 'interrupted', result, classification: c, reason: `killed: ${out.killedReason}` };
    else if (!result) outcome = { outcome: 'interrupted', result: null, classification: c, reason: `no result produced (${c.reason}${out.finalText ? ': ' + out.finalText.slice(0, 300) : ''})` };
    // An analyst that found the docs insufficient did its job (whatever status it chose): Plexus asks the user.
    else if (task.kind === 'ingest' && result.docs_check?.sufficient === false) outcome = { outcome: 'success', result, classification: c, reason: 'ok' };
    else if (result.status === 'blocked') outcome = { outcome: 'blocked', result, classification: c, reason: `blocked: ${result.summary}` };
    else if (result.status === 'failed') outcome = { outcome: 'failed', result, classification: c, reason: `failed: ${result.summary}` };
    else outcome = { outcome: 'success', result, classification: c, reason: 'ok' };

    finishRun(runId, outcome.outcome, { ...c, reason: outcome.reason }, out.exitCode, out.usage);
    keepNotes(p, task, wt, result);
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
 * CLI conversation this attempt can continue: the task's own (a retry, or the one it inherited from the task whose agent
 * it continues), else the latest one held by another task in the same worktree on this account (a fix or merge after
 * the author's build). Only that account's CLI home has the conversation, and Claude finds it by working directory, so
 * both must match. A conversation that grew too large (or went cold) is not resumed: a fresh start with notes is cheaper.
 */
export function resumableSession(p: Project, t: Task, account: Account): string | undefined {
  if (!p.settings.resumeSessions) return undefined;
  if (t.cliSessionId && t.cliAccountId === account.id) return resumeWorthIt(t.cliCtxTokens, t.cliUsedAt) ? t.cliSessionId : undefined;
  if (!t.worktree || !writesCode(t)) return undefined;
  const r = getDb().prepare(`SELECT cli_session_id AS s, cli_ctx_tokens AS ctx, cli_used_at AS at FROM tasks WHERE project_id = ? AND worktree = ? AND cli_account_id = ? AND cli_session_id IS NOT NULL AND id != ?
                             ORDER BY updated_at DESC LIMIT 1`).get(p.id, t.worktree, account.id, t.id) as any;
  return r?.s && resumeWorthIt(r.ctx ?? 0, r.at ?? null) ? r.s : undefined;
}

/** progress.md and the result summary of a run, kept in the project memory (the worktree may be removed after merge). */
function keepNotes(p: Project, t: Task, wt: string, result: AgentResult | null) {
  try {
    const f = join(wt, PROGRESS_FILE);
    const progress = existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
    const summary = result ? `## Result (${result.status})\n${result.summary}${result.issues.length ? `\n\nOpen issues:\n${result.issues.map(i => `- ${i}`).join('\n')}` : ''}` : '';
    const text = [progress && `## progress.md\n${progress}`, summary].filter(Boolean).join('\n\n');
    if (text) writeHandoff(p, shortId(t), `# ${shortId(t)}: ${t.title}\n\n${text}\n`);
  } catch { /* notes are best effort */ }
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
