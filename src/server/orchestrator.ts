import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Account, AgentResult, Project, Task } from '../shared/types.ts';
import { listAccounts, releaseCooldowns } from './accounts.ts';
import { setControlSession } from './chat.ts';
import { getDb, now } from './db.ts';
import { bus } from './events.ts';
import {
  appendIssues, appendMemory, getProject, listProjects, mustProject, parseDecisions, postMessage, readAcceptance, readMemory, recordDecision, replaceDecisions,
  setProjectStatus, plexusDir, updateProject, writeAcceptance, writeMemory,
} from './projects.ts';
import { getRole } from './roles.ts';
import { ACTIVE, createTask, getTask, listTasks, pathsOverlap, runnableTasks, setStatus, shortId, updateTask, USER_FOLLOW_UP } from './tasks.ts';
import { changedLines, git, hasCommitsAhead, removeWorktree } from './util/git.ts';
import { baseRef, commitsSince, conflictNotice, mergeIntoBase, prepareProjectRepo, type MergeOutcome } from './checkout.ts';
import { CONTEXT_DIR } from './context.ts';
import { running, runAttempt, writesCode, type AttemptOutcome } from './worker.ts';
import { appConfig } from './config.ts';

const UNAVAILABLE = new Set(['limited', 'transient', 'needs_login', 'blocked', 'disabled']);
const INDEPENDENT_KINDS = new Set(['review', 'evaluate']);
/** Evaluation gaps up to this many go to one single-agent task instead of one task (and hand-off) each (Settings → Scheduler). */
const bundleGapsMax = () => appConfig().gapBundleMax;

// ---------------- documentation check (no model call) ----------------

const DOC_FILE = /\.(md|markdown|txt|rst|adoc|org)$/i;
const NOT_DOCS = /^(license|licence|changelog|code_of_conduct|contributing|security|third[-_]party)/i;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'venv', '__pycache__', 'coverage']);

/** Documentation files of a project folder (root, docs/, specs/...; up to 3 levels, no hidden or build folders). */
export function scanDocs(root: string): { files: string[]; chars: number } {
  const files: string[] = [];
  let chars = 0;
  const walk = (dir: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= 200) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3 && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(full, depth + 1); continue; }
      if (!DOC_FILE.test(e.name) || NOT_DOCS.test(e.name)) continue;
      files.push(relative(root, full).replace(/\\/g, '/'));
      try { chars += statSync(full).size; } catch { /* vanished */ }
    }
  };
  walk(root, 0);
  return { files, chars };
}

/** Below both of these, Plexus asks the user what to build before spending any quota (Settings → Scheduler). */
const minGoalChars = () => appConfig().minGoalChars;
const minDocChars = () => appConfig().minDocChars;

export function pickAccount(p: Project, t: Task, accounts: Account[] = listAccounts()): Account | null {
  const role = getRole(t.role);
  const nowIso = now();
  let cands = accounts.filter(a => a.enabled && !UNAVAILABLE.has(a.state) && (a.running ?? 0) < a.maxConcurrency
    && (!a.cooldownUntil || a.cooldownUntil <= nowIso));
  // A pinned task runs on its account whenever that one can run; otherwise any other account takes over (below).
  if (t.pinnedAccountId) { const pin = cands.find(a => a.id === t.pinnedAccountId); if (pin) return pin; }
  // role.providers is a preference order; unless the role says onlyListed, any account can take any role when needed.
  if (role.onlyListed && role.providers.length) cands = cands.filter(a => role.providers.includes(a.provider));
  const author = t.authorAccountId ? accounts.find(a => a.id === t.authorAccountId) : null;
  if (INDEPENDENT_KINDS.has(t.kind) && author) {
    const others = cands.filter(a => a.id !== author.id);
    if (others.length) cands = others;
    else {
      // Another usable account exists but is busy/cooling down: wait for it a while before reviewing one's own work.
      const otherExists = accounts.some(a => a.id !== author.id && a.enabled && !['needs_login', 'blocked', 'disabled'].includes(a.state));
      const ageMin = (Date.now() - Date.parse(t.createdAt)) / 60_000;
      if (otherExists && ageMin < p.settings.independentReviewWaitMin) return null;
    }
  }
  if (!cands.length) return null;
  const used = (a: Account) => Math.max(a.quota?.primary?.usedPercent ?? 0, a.quota?.secondary?.usedPercent ?? 0);
  const stateRank = (a: Account) => (a.state === 'ok' ? 0 : a.state === 'unknown' ? 1 : 2); // warning last
  const prefIdx = (a: Account) => { const i = role.providers.indexOf(a.provider); return i < 0 ? 99 : i; };
  const strategy = p.settings.quotaStrategy;
  // Stay on the account that holds the context: retries and fixes/merges go back to the author (its CLI conversation
  // can be resumed), single-agent work to the coordinator's account.
  // A task holding a CLI conversation (its own, or one it continues) prefers the account that conversation lives on.
  const preferred = t.cliAccountId ?? (t.kind === 'solo' ? t.lastAccountId ?? p.settings.coordinatorAccountId
    : t.status === 'interrupted' || t.kind === 'fix' || t.kind === 'integrate' ? t.lastAccountId : null);
  return cands.sort((a, b) =>
    stateRank(a) - stateRank(b)
    || (INDEPENDENT_KINDS.has(t.kind) && author ? Number(a.provider === author.provider) - Number(b.provider === author.provider) : 0)
    || (preferred ? Number(b.id === preferred) - Number(a.id === preferred) : 0)
    || prefIdx(a) - prefIdx(b)
    || (strategy === 'spread' ? used(a) - used(b) : strategy === 'drain' ? used(b) - used(a) : 0)
    || a.priority - b.priority
    || a.id.localeCompare(b.id))[0];
}

const autoCommitHint = (p: Project) => appConfig().autoCommit ? `Make sure the project's main checkout is clean and on ${p.mainBranch}.` : "Check the task branch and Plexus's integration worktree.";

export class Orchestrator {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private inflight = new Set<Promise<void>>();
  private mergeLocks = new Map<string, Promise<unknown>>();
  private lastNoAccountNotice = new Map<string, number>();
  private pinNotified = new Set<string>();
  /** Outcomes being post-processed per project; phase transitions wait for them (avoids double finish). */
  private processing = new Map<string, number>();

  /** Fixed interval for tests; otherwise Settings → Scheduler, read before every pass. */
  private intervalMs: number | null = null;
  private stopped = false;

  private loop() {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tick().finally(() => this.loop()); }, this.intervalMs ?? appConfig().tickSec * 1000);
  }

  start(intervalMs?: number) {
    this.intervalMs = intervalMs ?? null;
    this.stopped = false;
    // Recovery: anything "running" when the daemon stopped is resumable work.
    const db = getDb();
    const stale = db.prepare(`SELECT id FROM tasks WHERE status = 'running'`).all() as any[];
    for (const r of stale) updateTask(r.id, { status: 'interrupted', accountId: null, error: 'daemon restarted while running' });
    this.loop();
    bus.on('event', ev => { if (ev.type === 'account.available') this.accountAvailable((ev.data as any).id, (ev.data as any).label); });
  }

  async stopAll() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const c of running.values()) c.abort();
    await Promise.allSettled([...this.inflight]);
  }

  /** Wait until no attempt is in flight (tests). */
  async idle() { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }

  // ---------------- project control ----------------

  /** `sessionId` is the chat session the user acted from: project-level notices go there (see chat.ts routeSession). */
  async startProject(id: string, sessionId?: string | null): Promise<Project> {
    setControlSession(id, sessionId);
    let p = mustProject(id);
    const repo = await prepareProjectRepo(p);
    if (repo.notice) postMessage(id, 'system', repo.notice, { level: 'attention' });
    p = updateProject(id, { mainBranch: repo.mainBranch });
    const pipeline = listTasks(id).filter(t => !t.adhoc);
    if ((!pipeline.length || p.phase === 'new' || p.phase === 'needs_input') && !pipeline.some(t => t.kind === 'ingest' && ACTIVE.includes(t.status) && t.status !== 'blocked')) {
      // Look before spending quota: with no goal and no documentation there is nothing to analyse yet.
      const docs = scanDocs(p.path);
      const said = `${readMemory(p, 'goal.md') || p.goal}\n${readMemory(p, 'directives.md')}`.trim();
      if (said.length < minGoalChars() && docs.chars < minDocChars()) {
        this.needsInput(p, [
          'What should be built? Describe the goal, the main features or tasks, and what "done" means.',
          'Any constraints (language, framework, platform, existing code to keep)?',
        ], `No goal and no documentation found in ${p.path}${docs.files.length ? ` (only ${docs.files.join(', ')})` : ''}, so no agent was started.`);
        return mustProject(id);
      }
      const list = docs.files.length
        ? `\nDocumentation files found: ${docs.files.slice(0, 60).join(', ')}${docs.files.length > 60 ? ', …' : ''}`
        : '\nNo documentation files were found; the goal and directives are all there is.';
      // The user answered the analyst's questions: the same analyst continues in its conversation (it has read the docs).
      const asked = p.phase === 'needs_input' ? pipeline.filter(t => t.kind === 'ingest' && t.status === 'done' && t.cliSessionId).at(-1) : null;
      if (asked) {
        setStatus(asked.id, 'pending', { attempts: 0, error: null, inbox: [...asked.inbox,
          'The user has answered your questions: the goal and directives now say what to build. Check them again; if they are enough, do the full analysis (brief, criteria, execution mode, code map).'] });
      } else {
        createTask(id, { title: 'Check the documentation, then analyse goal and docs', role: 'analyst', kind: 'ingest', priority: 100,
          description: 'First check whether the goal and documentation say clearly what to build; if not, return docs_check.sufficient=false with your questions and stop. ' +
            'Otherwise produce the project brief, the acceptance criteria and the execution mode.' + list });
      }
      updateProject(id, { phase: 'ingest' });
    }
    setProjectStatus(id, 'running');
    postMessage(id, 'system', `Plexus started (phase: ${mustProject(id).phase}).`);
    void this.tick();
    return mustProject(id);
  }

  /** Stop before spending (more) quota and ask the user what to build; the coordinator records the answer and resumes. */
  needsInput(p: Project, questions: string[], why: string, taskId?: string) {
    updateProject(p.id, { phase: 'needs_input' });
    setProjectStatus(p.id, 'paused');
    const qs = (questions.length ? questions : ['What should be built, and what does "done" mean?']).map((q, i) => `${i + 1}. ${q}`).join('\n');
    postMessage(p.id, 'system', `${why}\nPlexus needs your input before it builds anything:\n${qs}\nAnswer here in the chat (or add it to GOAL.md / docs/), then resume.`,
      { level: 'attention', ...(taskId ? { taskId } : {}) });
  }

  pause(id: string, sessionId?: string | null) {
    setControlSession(id, sessionId);
    setProjectStatus(id, 'paused');
    postMessage(id, 'system', 'Paused: no new pipeline tasks will start; running tasks finish their current attempt. Requests from the chat still run.');
  }

  resume(id: string, sessionId?: string | null) {
    setControlSession(id, sessionId);
    const p = mustProject(id);
    if (p.phase === 'new' || p.phase === 'needs_input' || !listTasks(id).some(t => !t.adhoc)) return this.startProject(id, sessionId);
    // Plexus stopped to ask (gaps that made no progress, or a blocked task): the user answered, continue from there.
    if (p.phase === 'waiting') { this.continueAfterWait(p); return; }
    for (const t of listTasks(id)) if (t.status === 'blocked' && !t.adhoc) setStatus(t.id, 'pending', { error: null });
    // Resuming a finished project means "keep working": new/remaining tasks run, then QA and evaluation again.
    if (p.status === 'completed' || p.phase.startsWith('done')) updateProject(id, { phase: 'build' });
    setProjectStatus(id, 'running');
    postMessage(id, 'system', 'Resumed.');
    void this.tick();
  }

  stop(id: string, sessionId?: string | null) {
    setControlSession(id, sessionId);
    setProjectStatus(id, 'stopped');
    let n = 0;
    for (const t of listTasks(id)) if (t.status === 'running') { running.get(t.id)?.abort(); n++; }
    postMessage(id, 'system', `Stopped. ${n} running task(s) were interrupted; their work is kept and will continue on resume.`);
  }

  cancelTask(id: string) {
    const t = getTask(id);
    if (!t) throw new Error('no such task');
    running.get(id)?.abort();
    setStatus(id, 'cancelled', { accountId: null });
  }

  retryTask(id: string) {
    const t = getTask(id);
    if (!t) throw new Error('no such task');
    setStatus(id, 'pending', { attempts: 0, error: null });
    void this.tick();
  }

  /** A message for a task's agent: delivered with its next run (a blocked task is woken up by it). */
  sendMessage(id: string, text: string): Task {
    const t = getTask(id);
    if (!t) throw new Error('no such task');
    const out = updateTask(t.id, { inbox: [...t.inbox, text.trim()] });
    if (t.status === 'blocked') { setStatus(t.id, 'pending', { error: null }); void this.tick(); }
    return out;
  }

  /**
   * More work for the agent that did `id`: a new task that continues its CLI conversation in the same worktree path
   * (a lane), so the agent does not re-read the project. Code-writing kinds continue as single-agent work.
   */
  continueTask(id: string, instructions: string, title = '', sessionId?: string | null, fromUser = false): Task {
    const prev = getTask(id);
    if (!prev) throw new Error('no such task');
    if (ACTIVE.includes(prev.status) && prev.status !== 'blocked') {
      // Still running or queued: the instructions go to its inbox instead.
      return this.sendMessage(prev.id, instructions);
    }
    const t = createTask(prev.projectId, {
      title: title || `${fromUser ? USER_FOLLOW_UP : 'Continue '}${shortId(prev)}: ${instructions.split('\n')[0].slice(0, 60)}`, description: instructions,
      role: 'solo', kind: 'solo', priority: 80, adhoc: true, originSessionId: sessionId ?? prev.originSessionId, laneFrom: prev,
      paths: prev.paths, pinnedAccountId: prev.pinnedAccountId,
    });
    // The model and effort chosen for that agent carry over to its continuation.
    if (Object.keys(prev.models).length || Object.keys(prev.efforts).length) updateTask(t.id, { models: prev.models, efforts: prev.efforts }, true);
    void this.tick();
    return t;
  }

  // ---------------- coordinator edits on the main checkout ----------------

  private mainHolds = new Map<string, { release: () => void; timer: NodeJS.Timeout }>();

  /**
   * The coordinator edits the main checkout: merges wait until it commits (plexus_main_commit) or 10 minutes pass, so a
   * merge never meets a half-edited working tree.
   */
  holdMain(projectId: string, maxMs = appConfig().mainHoldMin * 60_000): Promise<void> {
    if (this.mainHolds.has(projectId)) return Promise.resolve();
    const prev = this.mergeLocks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const timer = setTimeout(() => this.releaseMain(projectId), maxMs);
    this.mainHolds.set(projectId, { release, timer });
    const acquired: Promise<void> = prev.then(() => {}, () => {});
    this.mergeLocks.set(projectId, acquired.then(() => held));
    return acquired;
  }

  releaseMain(projectId: string): boolean {
    const h = this.mainHolds.get(projectId);
    if (!h) return false;
    clearTimeout(h.timer);
    this.mainHolds.delete(projectId);
    h.release();
    return true;
  }

  /** A merge landed on the base but could not be written into the project folder (the user edits those files). */
  private reportSync(p: Project, r: MergeOutcome) {
    if (r.ok && r.sync && !r.sync.ok) postMessage(p.id, 'system', conflictNotice(r.sync), { level: 'attention' });
  }

  /** Merge a branch the coordinator worked on (its own worktree) through the same queue as task merges. */
  mergeCoordinatorBranch(p: Project, branch: string, message: string): Promise<{ ok: boolean; detail: string }> {
    const prev = this.mergeLocks.get(p.id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const r = await mergeIntoBase(p, branch, message);
      this.reportSync(p, r);
      return { ok: r.ok, detail: r.ok ? 'merged' : `${r.conflict ? 'conflict' : 'failed'}: ${r.detail}` };
    });
    this.mergeLocks.set(p.id, next.catch(() => {}));
    return next;
  }

  // ---------------- scheduler ----------------

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      releaseCooldowns();
      for (const p of listProjects()) {
        if (p.status === 'running') {
          await this.advance(p.id);
          this.schedule(mustProject(p.id));
        } else { // idle, completed, paused, stopped: chat requests only
          this.dropDeadRequests(p);
          this.schedule(p, true);
        }
      }
    } catch (e: any) {
      bus.emitEvent('orchestrator.error', null, { message: String(e?.stack ?? e) });
    } finally { this.ticking = false; }
  }

  /** advance() does not run while the pipeline is stopped: a request task whose dependency failed would wait forever. */
  private dropDeadRequests(p: Project) {
    const tasks = listTasks(p.id);
    const byId = new Map(tasks.map(t => [t.id, t]));
    for (const t of tasks) {
      if (t.adhoc && t.status === 'pending' && t.deps.some(d => ['failed', 'cancelled'].includes(byId.get(d)?.status ?? ''))) {
        setStatus(t.id, 'cancelled', { error: 'a dependency failed' });
        postMessage(p.id, 'system', `${shortId(t)} "${t.title}" was cancelled because a task it waited for failed.`, { taskId: t.id, level: 'attention' });
      }
    }
  }

  /** Why a project currently can't start work, for the UI: no usable account (with the earliest reset, if known). */
  readonly waiting = new Map<string, { since: string; nextReset: string | null; tasks: number }>();

  private setWaiting(id: string, w: { nextReset: string | null; tasks: number } | null) {
    const prev = this.waiting.get(id);
    if (!w) {
      if (prev) { this.waiting.delete(id); bus.emitEvent('project.waiting', id, null, false); }
      return;
    }
    if (prev && prev.nextReset === w.nextReset && prev.tasks === w.tasks) return;
    const next = { since: prev?.since ?? now(), ...w };
    this.waiting.set(id, next);
    bus.emitEvent('project.waiting', id, next, false);
  }

  /** `adhocOnly`: the project pipeline is not running; only chat requests (adhoc tasks and their review / fix / conflict tasks) may start. */
  private schedule(p: Project, adhocOnly = false) {
    const all = listTasks(p.id);
    const active = all.filter(t => t.status === 'running');
    let slots = p.settings.maxParallel - active.length;
    const runnable = runnableTasks(p.id).filter(t => !adhocOnly || t.adhoc);
    if (slots <= 0 || !runnable.length) { if (!runnable.length || active.length) this.setWaiting(p.id, null); return; }
    let accounts = listAccounts();
    const byRole = new Map<string, number>();
    for (const t of active) byRole.set(t.role, (byRole.get(t.role) ?? 0) + 1);
    let noAccount = 0;
    let launched = 0;
    for (const t of runnable) {
      if (slots <= 0) break;
      // Issue #2: per-role parallel limit.
      const role = getRole(t.role);
      if (role.maxParallel > 0 && (byRole.get(t.role) ?? 0) >= role.maxParallel) continue;
      // Issue #2: two code-writing tasks never run at once on overlapping files.
      if (writesCode(t) && t.paths.length) {
        const clash = active.find(o => o.paths.length && writesCode(o) && !(o.worktree && o.worktree === t.worktree) && pathsOverlap(o.paths, t.paths));
        if (clash) continue;
      }
      const a = pickAccount(p, t, accounts);
      if (a && t.pinnedAccountId && a.id !== t.pinnedAccountId && !this.pinNotified.has(t.id)) {
        this.pinNotified.add(t.id);
        postMessage(p.id, 'system', `${shortId(t)} is pinned to ${t.pinnedAccountId}, which cannot run now; ${a.label || a.id} continues it.`, { taskId: t.id, level: 'handoff' });
      }
      if (!a) {
        noAccount++;
        const last = this.lastNoAccountNotice.get(p.id) ?? 0;
        if (Date.now() - last > appConfig().noAccountNoticeMin * 60_000) {
          this.lastNoAccountNotice.set(p.id, Date.now());
          const nowIso = now();
          const next = accounts.filter(x => x.enabled && x.cooldownUntil && x.cooldownUntil > nowIso).map(x => x.cooldownUntil!).sort()[0];
          const someFree = accounts.some(x => x.enabled && !UNAVAILABLE.has(x.state) && (x.running ?? 0) < x.maxConcurrency);
          bus.emitEvent('scheduler.waiting', p.id, { task: shortId(t), nextCooldownEnd: next ?? null, independentReview: someFree });
          if (someFree && INDEPENDENT_KINDS.has(t.kind)) {
            postMessage(p.id, 'system', `${shortId(t)} (${t.role}) is waiting for an account other than the author (up to ${p.settings.independentReviewWaitMin} min).`);
          } else {
            postMessage(p.id, 'system', `No account available for ${shortId(t)} (${t.role}). Waiting${next ? ` — earliest reset ${new Date(next).toLocaleString()}` : ''}.`, { level: next ? 'handoff' : 'attention' });
          }
        }
        continue;
      }
      slots--;
      launched++;
      byRole.set(t.role, (byRole.get(t.role) ?? 0) + 1);
      active.push({ ...t, status: 'running' });
      accounts = accounts.map(x => (x.id === a.id ? { ...x, running: (x.running ?? 0) + 1 } : x));
      const pr = this.launch(p, t, a);
      this.inflight.add(pr);
      void pr.finally(() => this.inflight.delete(pr));
    }
    // Issue #5: the project is "waiting for quota" when work is ready but nothing runs for lack of an account.
    if (noAccount && !launched && !active.length) {
      const nowIso = now();
      const next = accounts.map(x => x.enabled && x.cooldownUntil && x.cooldownUntil > nowIso ? x.cooldownUntil : null).filter((x): x is string => !!x).sort()[0] ?? null;
      this.setWaiting(p.id, { nextReset: next, tasks: noAccount });
    } else if (launched || active.length) this.setWaiting(p.id, null);
  }

  /** Issue #5: an account became usable again (quota reset, login, re-enabled): tell waiting projects and schedule now. */
  accountAvailable(accountId: string, label: string) {
    for (const [pid] of this.waiting) {
      const p = getProject(pid);
      if (p?.status !== 'running') continue;
      postMessage(pid, 'system', `${label} is available again. Continuing.`, { level: 'done' });
      this.lastNoAccountNotice.delete(pid);
    }
    void this.tick();
  }

  private async launch(p: Project, t: Task, a: Account) {
    const out = await runAttempt(p, t, a);
    this.processing.set(p.id, (this.processing.get(p.id) ?? 0) + 1);
    try { await this.handleOutcome(t.id, a, out); }
    catch (e: any) {
      updateTask(t.id, { status: 'interrupted', error: `post-processing failed: ${e?.message ?? e}` });
      bus.emitEvent('orchestrator.error', p.id, { task: t.id, message: String(e?.stack ?? e) });
    } finally { this.processing.set(p.id, (this.processing.get(p.id) ?? 1) - 1); }
    void this.tick();
  }

  // ---------------- outcomes ----------------

  private async handleOutcome(taskId: string, account: Account, out: AttemptOutcome) {
    const t = getTask(taskId)!;
    const p = mustProject(t.projectId);
    if (t.status === 'cancelled') return;
    const accountProblem = ['limited', 'transient', 'needs_login', 'blocked'].includes(out.classification.state);

    if (out.outcome === 'blocked') {
      // Retrying with the same input gives the same answer: wait for the user (or the coordinator) instead.
      const r = out.result!;
      this.absorbCommon(p, t, account, r);
      updateTask(t.id, { status: 'blocked', result: r, accountId: null, error: out.reason });
      const pipeline = !t.adhoc && mustProject(p.id).status === 'running';
      postMessage(p.id, 'system', `${shortId(t)} "${t.title}" is blocked and waits for you: ${r.summary}${r.questions.length ? `\n${r.questions.map(q => `- ${q.question}`).join('\n')}` : ''}\n` +
        `Answer in the chat (the coordinator passes it on with send_message), or retry the task.${pipeline ? ' The project is paused meanwhile.' : ''}`,
        { taskId: t.id, level: 'attention' });
      if (pipeline && !listTasks(p.id).some(x => x.id !== t.id && x.status === 'running')) this.pause(p.id);
      return;
    }

    if (out.outcome !== 'success') {
      const stopped = out.reason === 'stopped by user';
      const attempts = t.attempts + (accountProblem || stopped ? 0 : 1);
      if (attempts >= p.settings.maxAttempts) {
        updateTask(t.id, { status: 'failed', attempts, accountId: null, error: out.reason });
        appendMemory(p, 'known-issues.md', `- ${shortId(t)} "${t.title}" failed after ${attempts} attempts: ${out.reason}`);
        postMessage(p.id, 'system', `${shortId(t)} "${t.title}" failed after ${attempts} attempts: ${out.reason}`, { taskId: t.id, level: 'error' });
        if (['ingest', 'architect', 'plan'].includes(t.kind)) {
          this.pause(p.id);
          postMessage(p.id, 'system', `The ${t.kind} step is required to continue. Check the logs, then retry the task or give instructions in the chat.`, { level: 'attention' });
        }
      } else {
        updateTask(t.id, { status: 'interrupted', attempts, accountId: null, error: out.reason });
        if (accountProblem) postMessage(p.id, 'system', `${shortId(t)} paused on ${account.id}: ${out.reason}. It will be handed to the next available account.`, { taskId: t.id, level: 'handoff' });
      }
      return;
    }

    const r = out.result!;
    this.absorbCommon(p, t, account, r);
    updateTask(t.id, { result: r, accountId: null, error: null, authorAccountId: writesCode(t) ? account.id : t.authorAccountId });

    switch (t.kind) {
      case 'ingest': {
        await this.finishNonCode(p, t);
        // The docs do not say what to build: ask the user instead of letting the whole team guess.
        if (r.docs_check?.sufficient === false) {
          this.needsInput(p, r.docs_check.questions, `${shortId(t)}: the goal and documentation are not clear enough to start.`, t.id);
          break;
        }
        if (r.project_brief) writeMemory(p, 'brief.md', r.project_brief);
        if (r.codemap?.trim()) writeMemory(p, 'codemap.md', r.codemap);
        if (r.project_summary) writeMemory(p, 'summary.md', r.project_summary);
        if (r.acceptance_criteria?.length) writeAcceptance(p, r.acceptance_criteria.map(a => ({ ...a, pass: null })));
        // Single agent unless the settings or the analyst say the work needs a team.
        const mode = p.settings.pipeline === 'auto' ? r.execution?.mode ?? 'single' : p.settings.pipeline;
        postMessage(p.id, 'system', `Execution: ${mode === 'single' ? 'one agent builds the project' : 'team (architect plans, implementers work in parallel)'}` +
          `${p.settings.pipeline === 'auto' && r.execution?.reason ? ` — ${r.execution.reason}` : ''}.`, { taskId: t.id });
        if (mode === 'single') this.createSoloBuild(p, t, 1);
        else this.createArchitect(p, t);
        break;
      }
      case 'architect':
        await this.integrate(p, getTask(t.id)!);
        if (getTask(t.id)!.status === 'done') this.afterArchitect(p, getTask(t.id)!);
        break;
      case 'solo': await this.onSolo(p, getTask(t.id)!, r); break;
      case 'plan': {
        await this.finishNonCode(p, t);
        this.createPlannedTasks(p, t, r.tasks?.length ? r.tasks : [{ title: 'Implement the project', description: 'Implement the whole project as described in ARCHITECTURE.md and the brief.', role: 'implementer', depends_on: [], acceptance: [], paths: [], ac_ids: [] }]);
        updateProject(p.id, { phase: 'build' });
        break;
      }
      case 'review': await this.onReview(p, t, r); break;
      case 'integrate': {
        await this.finishNonCodeKeepWorktree(t);
        const target = t.parentId ? getTask(t.parentId) : null;
        if (target) await this.merge(p, target);
        break;
      }
      case 'evaluate': await this.onEvaluate(p, t, r); break;
      case 'compact': await this.onCompact(p, getTask(t.id)!, account, r); break;
      default: // build, fix, qa, custom
        if (writesCode(t)) await this.integrate(p, getTask(t.id)!);
        else await this.finishNonCode(p, t);
    }
    // Solo and evaluation results fold their follow-ups into the next step themselves (fewer hand-offs).
    if (mustProject(p.id).status !== 'completed' && t.kind !== 'solo' && t.kind !== 'evaluate') this.createFollowUps(p, getTask(t.id)!, r);
    this.reportRequestDone(p, getTask(t.id)!);
  }

  private reportedRequests = new Set<string>();

  /** A chat request done by team roles (build/custom with its review, fixes, merge) is finished: tell the chat. */
  private reportRequestDone(p: Project, t: Task) {
    let root = t;
    for (let guard = 0; root.parentId && guard < 20; guard++) root = getTask(root.parentId) ?? root;
    if (!root.adhoc || root.kind === 'solo' || root.status !== 'done' || this.reportedRequests.has(root.id)) return;
    this.reportedRequests.add(root.id);
    const r = root.result;
    postMessage(p.id, 'agent', `${shortId(root)} "${root.title}" finished${r ? ` (${r.status}): ${r.summary || '(no summary given)'}` : '.'}`,
      { taskId: root.id, level: 'done' });
  }

  private createArchitect(p: Project, after: Task | null) {
    createTask(p.id, { title: 'Design architecture, skeleton and task plan', role: 'architect', kind: 'architect', priority: 95, deps: after ? [after.id] : [],
      description: 'Design the architecture, create the project skeleton and plan the implementation tasks in this same session (return them in `tasks`).' });
    updateProject(p.id, { phase: 'architect' });
  }

  /** The architect plans too; a separate planner runs only when it returned no tasks (older custom architect roles). */
  private afterArchitect(p: Project, arch: Task) {
    if (listTasks(p.id).some(x => !x.adhoc && ['plan', 'build'].includes(x.kind) && x.seq > arch.seq)) return;
    const tasks = arch.result?.tasks ?? [];
    if (tasks.length) {
      this.createPlannedTasks(p, arch, tasks);
      updateProject(p.id, { phase: 'build' });
    } else {
      createTask(p.id, { title: 'Plan implementation tasks', role: 'planner', kind: 'plan', priority: 90, deps: [arch.id] });
      updateProject(p.id, { phase: 'plan' });
    }
  }

  /**
   * One agent (the coordinator's model) builds the whole project, or closes the gaps of the previous round. A gap round
   * continues the previous round's agent (same conversation and worktree path) and only carries the open criteria.
   */
  private createSoloBuild(p: Project, after: Task | null, round: number, gaps = '', prev: Task | null = null, openIds: string[] = []) {
    createTask(p.id, {
      title: round === 1 ? 'Build the project (single agent)' : `Close the remaining gaps (round ${round})`, role: 'solo', kind: 'solo', priority: 90,
      deps: after ? [after.id] : [],
      description: round === 1
        ? 'Build the whole project described by the brief and the acceptance criteria on your own: design (short ARCHITECTURE.md), implement, ' +
          'test, review your own diff, and verify every acceptance criterion by running its check. Report the verification in `evaluation`.'
        : `The project is not complete yet. Close these gaps (change the code where needed), then re-check the affected criteria and report every criterion in \`evaluation\`:\n${gaps}`,
      laneFrom: prev, acIds: openIds, pinnedAccountId: prev?.pinnedAccountId ?? null,
    });
    updateProject(p.id, { phase: 'solo' });
  }

  private applyEvaluation(p: Project, ev: AgentResult['evaluation']) {
    if (!ev) return;
    const acc = readAcceptance(p);
    for (const c of ev.criteria) {
      const a = acc.find(x => x.id === c.id);
      if (a) { a.pass = c.pass; a.evidence = c.evidence; a.needs = c.pass === 'blocked' ? c.needs ?? 'environment' : undefined; }
    }
    if (acc.length) writeAcceptance(p, acc);
  }

  /** What is still missing after an evaluation: failing criteria and follow-up items, as one list for one agent. Blocked criteria are not gaps. */
  private gapList(ev: AgentResult['evaluation'], followUps: AgentResult['follow_up_tasks']): string {
    const failing = (ev?.criteria ?? []).filter(c => c.pass === false).map(c => `- ${c.id} fails: ${c.evidence}`);
    const items = followUps.map(f => `- ${f.title}: ${f.description}${f.acceptance.length ? ` (done when: ${f.acceptance.join('; ')})` : ''}`);
    return [...failing, ...items].join('\n') || '- (the previous round reported the project incomplete without details; re-check every criterion)';
  }

  /** The evaluation (solo or evaluator) before `t` in the project pipeline, to tell whether a round made progress. */
  private previousEvaluation(p: Project, t: Task): AgentResult['evaluation'] | null {
    const prev = listTasks(p.id).filter(x => !x.adhoc && x.seq < t.seq && x.status === 'done' && ['solo', 'evaluate'].includes(x.kind) && x.result?.evaluation).at(-1);
    return prev?.result?.evaluation ?? null;
  }

  /**
   * Is another round worth it? Not when the round changed no code, or did not reduce the failing criteria, or when only
   * criteria that cannot be checked here (blocked) remain: another agent would hit the same wall.
   */
  private stalled(ev: AgentResult['evaluation'], prev: AgentResult['evaluation'] | null, changedCode: boolean): string | null {
    const failing = (ev?.criteria ?? []).filter(c => c.pass === false).length;
    const blocked = (ev?.criteria ?? []).filter(c => c.pass === 'blocked').length;
    if (!failing && blocked) return `only criteria that cannot be checked here remain (${blocked})`;
    if (!prev) return changedCode ? null : 'the round changed no code';
    const before = prev.criteria.filter(c => c.pass === false).length;
    if (failing >= before) return changedCode ? `the failing criteria did not go down (${before} → ${failing})` : 'the round changed no code and fixed no criterion';
    return null;
  }

  /**
   * Stop and ask instead of starting a round that would not converge. The open gaps are kept (open-gaps.md); after the
   * user's answer (a directive, an install, a decision) `resume` continues with them.
   */
  private waitForUser(p: Project, t: Task, ev: AgentResult['evaluation'], gaps: string, why: string) {
    const blocked = (ev?.criteria ?? []).filter(c => c.pass === 'blocked');
    writeMemory(p, 'open-gaps.md', `# Open gaps after ${shortId(t)}\n\nStopped because ${why}.\n\n${gaps}\n${blocked.length ? `\n## Cannot be checked here\n${blocked.map(c => `- ${c.id} (needs ${c.needs ?? 'environment'}): ${c.evidence}`).join('\n')}\n` : ''}`);
    updateProject(p.id, { phase: 'waiting' });
    setProjectStatus(p.id, 'paused');
    const lines = [
      `Plexus stopped instead of starting another round: ${why}.`,
      gaps.trim() ? `Still failing:\n${gaps}` : '',
      blocked.length ? `Cannot be checked here:\n${blocked.map(c => `- ${c.id} (needs ${c.needs ?? 'environment'}): ${c.evidence}`).join('\n')}` : '',
      'Tell the coordinator what to change (install something, drop or reword a criterion, give a decision), then Resume. Or Stop to keep it as it is.',
    ];
    postMessage(p.id, 'system', lines.filter(Boolean).join('\n\n'), { taskId: t.id, level: 'attention' });
  }

  /** Resume after waitForUser: one more round with the open gaps, continuing the last agent. */
  private continueAfterWait(p: Project) {
    const pipeline = listTasks(p.id).filter(t => !t.adhoc);
    const last = pipeline.filter(t => ['solo', 'evaluate'].includes(t.kind)).at(-1) ?? null;
    const lane = pipeline.filter(t => t.kind === 'solo').at(-1) ?? null;
    const gaps = readMemory(p, 'open-gaps.md').trim() || '- re-check every criterion';
    const open = (last?.result?.evaluation?.criteria ?? []).filter(c => c.pass !== true).map(c => c.id);
    setProjectStatus(p.id, 'running');
    this.createSoloBuild(p, null, p.evalRounds + 1, `${gaps}\n\nThe user has answered in the meantime: read the directives and messages first.`, lane, open);
    postMessage(p.id, 'system', 'Resumed: one agent continues with the open gaps.');
    void this.tick();
  }

  /**
   * A single-agent task finished (it is merged directly: it reviewed itself). A chat request just reports back; the
   * project's single-agent build is complete, continues with the gaps, or hands the rest to a team when it escalated.
   */
  private async onSolo(p: Project, t: Task, r: AgentResult) {
    const changedCode = !!t.branch && await hasCommitsAhead(p.path, t.branch, baseRef(p));
    if (r.codemap?.trim()) writeMemory(p, 'codemap.md', r.codemap);
    await this.integrate(p, t);
    if (t.adhoc) {
      const fu = r.follow_up_tasks.length ? `\nSuggested follow-ups (not started): ${r.follow_up_tasks.map(f => f.title).join('; ')}` : '';
      postMessage(p.id, 'agent', `${shortId(t)} "${t.title}" finished (${r.status}): ${r.summary || '(no summary given)'}${fu}\n` +
        `To give this agent more work in the same context: continue_task ${shortId(t)}.`, { taskId: t.id, level: 'done' });
      return;
    }
    const cur = mustProject(p.id);
    // A gap bundle during a team build, or the merge is still pending (conflict): advance() takes it from here.
    if (cur.phase !== 'solo' || cur.status !== 'running' || getTask(t.id)!.status !== 'done') return;
    if (r.escalate?.reason) {
      postMessage(p.id, 'system', `${shortId(t)} hands the rest of the work to a team: ${r.escalate.reason}`, { taskId: t.id });
      this.createArchitect(p, null);
      return;
    }
    const ev = r.evaluation;
    const prevEv = this.previousEvaluation(p, t);
    this.applyEvaluation(p, ev);
    const rounds = cur.evalRounds + 1;
    updateProject(p.id, { evalRounds: rounds });
    if (ev?.complete) return this.finish(p, ev.report ?? r.summary, true);
    if (rounds >= p.settings.maxEvalRounds) return this.finish(p, ev?.report ?? r.summary, false, 'evaluation round limit reached');
    const gaps = this.gapList(ev, r.follow_up_tasks);
    // A round must show progress (fewer failing criteria) to get another one; the first round must at least have changed code.
    const why = this.stalled(ev, prevEv, changedCode);
    if (why) return this.waitForUser(mustProject(p.id), getTask(t.id)!, ev, gaps, why);
    postMessage(p.id, 'system', `Round ${rounds}: not complete yet; the same agent continues with the gaps in its own conversation.`, { taskId: t.id });
    const open = (ev?.criteria ?? []).filter(c => c.pass === false).map(c => c.id);
    this.createSoloBuild(p, null, rounds + 1, gaps, getTask(t.id), open);
  }

  private absorbCommon(p: Project, t: Task, a: Account, r: AgentResult) {
    for (const d of r.decisions) recordDecision(p, d, `${shortId(t)} (${t.role}, ${a.id})`);
    if (r.decisions.length) this.maybeCompactDecisions(p);
    appendIssues(p, shortId(t), r.issues);
    for (const q of r.questions) postMessage(p.id, 'agent', `${t.role} (${shortId(t)}) asks: ${q.question}\nAssumed for now: ${q.default_answer || '—'}`, { taskId: t.id, question: q.question, defaultAnswer: q.default_answer });
    bus.emitEvent('task.result', p.id, { id: t.id, seq: t.seq, title: t.title, status: r.status, summary: r.summary.slice(0, 1000), account: a.id });
  }

  private async finishNonCode(p: Project, t: Task) {
    setStatus(t.id, 'done');
    const cur = getTask(t.id)!;
    if (cur.worktree && !writesCode(cur)) await removeWorktree(p.path, cur.worktree).catch(() => {});
  }

  private async finishNonCodeKeepWorktree(t: Task) { setStatus(t.id, 'done'); }

  /** Code task finished: send to review or merge. */
  private async integrate(p: Project, t: Task) {
    const hasCommits = t.branch ? await hasCommitsAhead(p.path, t.branch, baseRef(p)) : false;
    if (!hasCommits) {
      setStatus(t.id, 'done');
      if (t.worktree) await removeWorktree(p.path, t.worktree).catch(() => {});
      this.markChainDone(t);
      return;
    }
    if (await this.needsReview(p, t)) {
      setStatus(t.id, 'in_review');
      createTask(p.id, {
        title: `Review ${shortId(t)}: ${t.title}`, role: 'reviewer', kind: 'review', parentId: t.id, priority: Math.min(99, t.priority + 5),
        authorAccountId: getTask(t.id)!.authorAccountId, reviewCycles: t.reviewCycles, paths: t.paths,
      });
    } else await this.merge(p, t);
  }

  /**
   * Review is a hand-off (another agent re-reads the context), so policy `auto` reviews only what is worth it: large
   * changes and ones the author flagged. Single-agent work reviews itself; a fix after review is merged without a
   * second review round.
   */
  private async needsReview(p: Project, t: Task): Promise<boolean> {
    const policy = p.settings.reviewEnabled === false ? 'never' : p.settings.reviewPolicy;
    if (policy === 'never' || ['qa', 'architect', 'solo', 'integrate'].includes(t.kind)) return false;
    if (policy === 'always') return true;
    if (t.kind === 'fix') return false;
    const r = getTask(t.id)!.result;
    if (r && (r.status === 'partial' || r.issues.length)) return true;
    return !!t.branch && await changedLines(p.path, baseRef(p), t.branch) >= p.settings.reviewMinLines;
  }

  private async onReview(p: Project, review: Task, r: AgentResult) {
    await this.finishNonCode(p, review);
    const target = review.parentId ? getTask(review.parentId) : null;
    if (!target) return;
    const verdict = r.review?.verdict ?? 'approve';
    if (verdict === 'approve') { await this.merge(p, target); return; }
    if (review.reviewCycles >= p.settings.maxReviewCycles) {
      appendMemory(p, 'known-issues.md', `- ${shortId(target)} merged after ${review.reviewCycles + 1} review rounds with open comments: ${(r.review?.comments ?? []).join(' | ')}`);
      await this.merge(p, target);
      return;
    }
    createTask(p.id, {
      title: `Fix review comments on ${shortId(target)}`, role: 'implementer', kind: 'fix', parentId: review.id,
      branch: target.branch, worktree: target.worktree, priority: Math.min(99, target.priority + 10), reviewCycles: review.reviewCycles + 1,
      description: `Address the review comments for task ${shortId(target)} ("${target.title}").\n\nOriginal task:\n${target.description}`,
      acceptance: target.acceptance, paths: target.paths,
      // Back to the author: same account and worktree, so its CLI conversation is resumed instead of re-reading everything.
      authorAccountId: target.authorAccountId, lastAccountId: target.authorAccountId,
    });
  }

  /** Serialized merge of a code task's branch into main. */
  private merge(p: Project, t: Task): Promise<void> {
    const prev = this.mergeLocks.get(p.id) ?? Promise.resolve();
    const next = prev.then(() => this.doMerge(mustProject(p.id), getTask(t.id)!)).catch(e => {
      bus.emitEvent('orchestrator.error', p.id, { task: t.id, message: `merge: ${e?.message ?? e}` });
    });
    this.mergeLocks.set(p.id, next);
    return next;
  }

  private async doMerge(p: Project, t: Task) {
    if (!t.branch) { setStatus(t.id, 'done'); this.markChainDone(t); return; }
    const r = await mergeIntoBase(p, t.branch, `merge ${shortId(t)}: ${t.title}`);
    this.reportSync(p, r);
    if (r.ok) {
      setStatus(t.id, 'done');
      this.markChainDone(t);
      if (t.worktree) await removeWorktree(p.path, t.worktree).catch(() => {});
      await git(p.path, 'branch', '-D', t.branch);
      bus.emitEvent('task.merged', p.id, { id: t.id, seq: t.seq, title: t.title, branch: t.branch });
      return;
    }
    if (!r.conflict) {
      setStatus(t.id, 'failed', { error: `merge failed: ${r.detail}` });
      postMessage(p.id, 'system', `Merging ${shortId(t)} failed (not a conflict): ${r.detail.slice(0, 500)}. ${autoCommitHint(p)}`, { level: 'attention' });
      this.pause(p.id);
      return;
    }
    const tries = listTasks(p.id).filter(x => x.kind === 'integrate' && x.parentId === t.id).length;
    if (tries >= appConfig().mergeConflictTries) {
      setStatus(t.id, 'failed', { error: 'merge conflicts could not be resolved' });
      appendMemory(p, 'known-issues.md', `- ${shortId(t)} could not be merged (conflicts persisted after ${tries} integration attempts)`);
      return;
    }
    setStatus(t.id, 'in_review', { error: 'merge conflict' });
    createTask(p.id, {
      title: `Resolve merge conflicts for ${shortId(t)}`, role: 'integrator', kind: 'integrate', parentId: t.id,
      branch: t.branch, worktree: t.worktree, priority: 98, paths: t.paths,
      description: `Branch ${t.branch} conflicts with ${baseRef(p)}:\n${r.detail.slice(0, 1500)}`,
      lastAccountId: t.authorAccountId, // the author's conversation knows this branch best
    });
  }

  /** When a fix/review chain completes, mark the original code task and intermediate tasks done. */
  private markChainDone(t: Task) {
    let cur: Task | null = t.parentId ? getTask(t.parentId) : null;
    let guard = 0;
    while (cur && guard++ < 20) {
      if (cur.status === 'in_review') setStatus(cur.id, 'done', { error: null });
      cur = cur.parentId ? getTask(cur.parentId) : null;
    }
  }

  private createPlannedTasks(p: Project, plan: Task, items: NonNullable<AgentResult['tasks']>) {
    const budget = p.settings.maxTasks - listTasks(p.id).length;
    const keyToId = new Map<string, string>();
    const created: Task[] = [];
    for (const it of items.slice(0, Math.max(0, budget))) {
      const role = it.role || 'implementer';
      const t = createTask(p.id, {
        title: it.title, description: it.description, role, kind: role === 'implementer' ? 'build' : 'custom',
        acceptance: it.acceptance, acIds: it.ac_ids, priority: it.priority ?? 50, deps: [], paths: it.paths, originSessionId: plan.originSessionId,
      });
      if (it.key) keyToId.set(it.key, t.id);
      keyToId.set(it.title, t.id);
      created.push(t);
    }
    items.slice(0, created.length).forEach((it, i) => {
      const deps = it.depends_on.map(k => keyToId.get(k)).filter((x): x is string => !!x && x !== created[i].id);
      if (deps.length) updateTask(created[i].id, { deps }, true);
    });
    if (items.length > created.length) postMessage(p.id, 'system', `Task budget reached: ${items.length - created.length} planned task(s) were not created (maxTasks=${p.settings.maxTasks}).`);
    postMessage(p.id, 'system', `Plan ready: ${created.length} task(s).`, { taskId: plan.id });
  }

  private createFollowUps(p: Project, t: Task, r: AgentResult) {
    if (!r.follow_up_tasks.length) return;
    // A chat request does exactly what was asked: follow-ups are suggestions for the user, not new pipeline work.
    if (t.adhoc) {
      postMessage(p.id, 'agent', `${shortId(t)} suggests follow-ups (not started): ${r.follow_up_tasks.map(f => f.title).join('; ')}`, { taskId: t.id });
      return;
    }
    // Before planning is done, suggested work goes to the planner as notes instead of becoming duplicate tasks.
    if (['ingest', 'architect', 'plan'].includes(t.kind)) {
      if (t.kind !== 'plan') appendMemory(p, 'planning-notes.md', r.follow_up_tasks.map(f => `- (${t.role}) ${f.title}: ${f.description}`).join('\n'));
      return;
    }
    let budget = p.settings.maxTasks - listTasks(p.id).length;
    for (const f of r.follow_up_tasks) {
      if (budget-- <= 0) { postMessage(p.id, 'system', `Task budget reached; follow-up "${f.title}" not created.`); break; }
      const role = f.role || 'implementer';
      createTask(p.id, { title: f.title, description: f.description, role, kind: role === 'implementer' ? 'build' : 'custom', acceptance: f.acceptance, acIds: f.ac_ids, priority: f.priority ?? 60, parentId: null, paths: f.paths, originSessionId: t.originSessionId });
    }
  }

  /** decisions.md is past the project's threshold: queue one librarian task to compact it (decisions are in every planner/architect prompt). */
  maybeCompactDecisions(p: Project) {
    const limit = p.settings.decisionsCompactAt;
    if (!limit || readMemory(p, 'decisions.md').length <= limit) return;
    if (listTasks(p.id).some(x => x.kind === 'compact' && ACTIVE.includes(x.status))) return;
    createTask(p.id, {
      title: 'Compact the decision log', role: 'librarian', kind: 'compact', priority: 97,
      description: `decisions.md has grown past ${limit} characters. Rewrite the decisions in ${CONTEXT_DIR}/decisions.md as a shorter digest.`,
    });
  }

  private async onCompact(p: Project, t: Task, a: Account, r: AgentResult) {
    // The librarian worked on the snapshot written into its worktree; decisions recorded since then are kept as they are.
    const snap = t.worktree && existsSync(join(t.worktree, CONTEXT_DIR, 'decisions.md')) ? readFileSync(join(t.worktree, CONTEXT_DIR, 'decisions.md'), 'utf8') : null;
    const covered = snap === null ? 0 : parseDecisions(snap).length;
    await this.finishNonCode(p, t);
    if (!r.decisions_digest?.length || !covered) { postMessage(p.id, 'system', `${shortId(t)}: the librarian returned no digest; decisions.md is unchanged.`, { taskId: t.id }); return; }
    const before = readMemory(p, 'decisions.md').length;
    replaceDecisions(p, r.decisions_digest, covered, `${shortId(t)} (${a.id})`);
    postMessage(p.id, 'system', `Decision log compacted: ${covered} entries → ${r.decisions_digest.length} (${before} → ${readMemory(p, 'decisions.md').length} chars). The previous text is in decisions-archive.md.`, { taskId: t.id });
  }

  private async onEvaluate(p: Project, t: Task, r: AgentResult) {
    await this.finishNonCode(p, t);
    const ev = r.evaluation;
    this.applyEvaluation(p, ev);
    const rounds = p.evalRounds + 1;
    updateProject(p.id, { evalRounds: rounds });
    const complete = !!ev?.complete;
    if (complete) return this.finish(p, ev?.report ?? r.summary, true);
    if (rounds >= p.settings.maxEvalRounds || !r.follow_up_tasks.length) {
      return this.finish(p, ev?.report ?? r.summary, false, rounds >= p.settings.maxEvalRounds ? 'evaluation round limit reached' : 'evaluator found gaps but proposed no tasks');
    }
    const fus = r.follow_up_tasks;
    // Rounds since the last evaluation that changed nothing, or did not reduce the failing criteria: ask, do not loop.
    const prevEv = this.previousEvaluation(p, t);
    const since = listTasks(p.id).filter(x => !x.adhoc && x.seq < t.seq && ['solo', 'evaluate'].includes(x.kind) && x.result?.evaluation).at(-1)?.updatedAt;
    const changed = !since || await commitsSince(p, since) > 0;
    const why = this.stalled(ev, prevEv, changed);
    if (why) return this.waitForUser(mustProject(p.id), t, ev, this.gapList(ev, fus), why);
    // A few gaps go to one agent (one hand-off, no review); many go back to the team as separate tasks.
    if (fus.length <= bundleGapsMax() || p.settings.pipeline === 'single') {
      const lane = listTasks(p.id).filter(x => x.kind === 'solo' && x.status === 'done').at(-1) ?? null;
      createTask(p.id, {
        title: `Fix the gaps found by evaluation round ${rounds}`, role: 'solo', kind: 'solo', priority: 70,
        description: `The evaluation found these gaps. Fix all of them, run the tests and re-check the affected acceptance criteria:\n${this.gapList(ev, fus)}`,
        acIds: [...fus.flatMap(f => f.ac_ids), ...(ev?.criteria ?? []).filter(c => c.pass === false).map(c => c.id)],
        paths: fus.flatMap(f => f.paths), originSessionId: t.originSessionId, laneFrom: lane,
      });
    } else this.createFollowUps(p, t, r);
    updateProject(p.id, { phase: 'build' });
    postMessage(p.id, 'system', `Evaluation round ${rounds}: not complete yet; ${fus.length} gap(s) ${fus.length <= bundleGapsMax() || p.settings.pipeline === 'single' ? 'given to one agent' : 'planned as separate tasks'}.`);
  }

  private finish(p: Project, report: string, complete: boolean, why = '') {
    if (mustProject(p.id).status === 'completed') return;
    const acc = readAcceptance(p);
    const passed = acc.filter(a => a.pass === true).length;
    const blocked = acc.filter(a => a.pass === 'blocked').length;
    const header = `# Plexus report — ${p.name}\n\nStatus: ${complete ? 'COMPLETE' : 'STOPPED WITH GAPS' + (why ? ` (${why})` : '')}\nAcceptance: ${passed}/${acc.length} passed${blocked ? `, ${blocked} cannot be checked here` : ''}\nFinished: ${now()}\n\n`;
    writeFileSync(join(plexusDir(p), 'REPORT.md'), header + report);
    updateProject(p.id, { phase: complete ? 'done' : 'done-with-gaps' });
    setProjectStatus(p.id, 'completed');
    postMessage(p.id, 'system', `${complete ? 'Project complete' : 'Plexus stopped with gaps'}: acceptance ${passed}/${acc.length}${blocked ? ` (${blocked} need a person or another environment)` : ''}. Report in .plexus/REPORT.md`, { level: 'done', report: true });
    bus.emitEvent('project.finished', p.id, { complete, passed, total: acc.length });
  }

  /** Phase transitions that happen when nothing is left to do in the current phase. */
  private async advance(projectId: string) {
    if ((this.processing.get(projectId) ?? 0) > 0) return;
    const p = mustProject(projectId);
    if (p.status !== 'running') return;
    const tasks = listTasks(projectId);
    const byId = new Map(tasks.map(t => [t.id, t]));
    // Pending tasks whose dependencies failed/cancelled can never run: cancel them.
    for (const t of tasks) {
      if (t.status === 'pending' && t.deps.some(d => ['failed', 'cancelled'].includes(byId.get(d)?.status ?? ''))) {
        setStatus(t.id, 'cancelled', { error: 'a dependency failed' });
        appendMemory(p, 'known-issues.md', `- ${shortId(t)} "${t.title}" was cancelled because a dependency failed`);
      }
    }
    const active = listTasks(projectId).some(t => ACTIVE.includes(t.status));
    if (active) return;
    // A pipeline task waits for the user: no phase moves on without it.
    if (listTasks(projectId).some(t => t.status === 'blocked' && !t.adhoc)) return;
    const pipeline = listTasks(projectId).filter(t => !t.adhoc);
    const evaluate = () => {
      createTask(p.id, { title: `Evaluate against goal and acceptance criteria (round ${p.evalRounds + 1})`, role: 'evaluator', kind: 'evaluate', priority: 85 });
      updateProject(p.id, { phase: 'evaluate' });
    };
    if (p.phase === 'build') {
      // The evaluator builds, runs the tests and checks every criterion anyway; a separate QA pass is optional.
      if (p.settings.qaPhase) {
        createTask(p.id, { title: 'QA: test the integrated product', role: 'qa', kind: 'qa', priority: 80 });
        updateProject(p.id, { phase: 'qa' });
      } else evaluate();
    } else if (p.phase === 'qa') evaluate();
    else if (p.phase === 'architect') {
      // The architect's branch was merged after a conflict (integrator): continue with its plan.
      const arch = pipeline.filter(t => t.kind === 'architect').at(-1);
      if (arch?.status === 'done') this.afterArchitect(p, arch);
    } else if (p.phase === 'solo') {
      // Single-agent build without a verdict (merge went through an integrator, or the agent failed).
      const last = pipeline.filter(t => t.kind === 'solo').at(-1);
      if (last?.status === 'failed') this.finish(p, 'The single-agent build failed (see known issues).', false, 'single agent failed');
      else evaluate();
    } else if (p.phase === 'evaluate' && listTasks(projectId).filter(t => t.kind === 'evaluate').at(-1)?.status !== 'done') {
      this.finish(p, 'The evaluation step could not be completed (see known issues).', false, 'evaluator failed');
    }
  }
}

export const orchestrator = new Orchestrator();
