import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, AgentResult, Project, Task } from '../shared/types.ts';
import { listAccounts, releaseCooldowns } from './accounts.ts';
import { getDb, now } from './db.ts';
import { bus } from './events.ts';
import {
  appendMemory, getProject, listProjects, mustProject, postMessage, readAcceptance, recordDecision, setProjectStatus,
  plexusDir, updateProject, writeAcceptance, writeMemory,
} from './projects.ts';
import { getRole } from './roles.ts';
import { ACTIVE, createTask, getTask, listTasks, pathsOverlap, runnableTasks, setStatus, shortId, updateTask } from './tasks.ts';
import { ensureRepo, commitAll, git, hasCommitsAhead, mergeBranch, removeWorktree } from './util/git.ts';
import { running, runAttempt, writesCode, type AttemptOutcome } from './worker.ts';

const UNAVAILABLE = new Set(['limited', 'transient', 'needs_login', 'blocked', 'disabled']);
const INDEPENDENT_KINDS = new Set(['review', 'evaluate']);

export function pickAccount(p: Project, t: Task, accounts: Account[] = listAccounts()): Account | null {
  const role = getRole(t.role);
  const nowIso = now();
  let cands = accounts.filter(a => a.enabled && !UNAVAILABLE.has(a.state) && (a.running ?? 0) < a.maxConcurrency
    && (!a.cooldownUntil || a.cooldownUntil <= nowIso));
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
  return cands.sort((a, b) =>
    stateRank(a) - stateRank(b)
    || (INDEPENDENT_KINDS.has(t.kind) && author ? Number(a.provider === author.provider) - Number(b.provider === author.provider) : 0)
    || (t.status === 'interrupted' || t.kind === 'fix' ? Number(b.id === t.lastAccountId) - Number(a.id === t.lastAccountId) : 0)
    || prefIdx(a) - prefIdx(b)
    || (strategy === 'spread' ? used(a) - used(b) : strategy === 'drain' ? used(b) - used(a) : 0)
    || a.priority - b.priority
    || a.id.localeCompare(b.id))[0];
}

export class Orchestrator {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private inflight = new Set<Promise<void>>();
  private mergeLocks = new Map<string, Promise<unknown>>();
  private lastNoAccountNotice = new Map<string, number>();
  /** Outcomes being post-processed per project; phase transitions wait for them (avoids double finish). */
  private processing = new Map<string, number>();

  start(intervalMs = 2000) {
    // Recovery: anything "running" when the daemon stopped is resumable work.
    const db = getDb();
    const stale = db.prepare(`SELECT id FROM tasks WHERE status = 'running'`).all() as any[];
    for (const r of stale) updateTask(r.id, { status: 'interrupted', accountId: null, error: 'daemon restarted while running' });
    this.timer = setInterval(() => void this.tick(), intervalMs);
    bus.on('event', ev => { if (ev.type === 'account.available') this.accountAvailable((ev.data as any).id, (ev.data as any).label); });
  }

  async stopAll() {
    if (this.timer) clearInterval(this.timer);
    for (const c of running.values()) c.abort();
    await Promise.allSettled([...this.inflight]);
  }

  /** Wait until no attempt is in flight (tests). */
  async idle() { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }

  // ---------------- project control ----------------

  async startProject(id: string): Promise<Project> {
    let p = mustProject(id);
    const main = await ensureRepo(p.path);
    if (await commitAll(p.path, 'chore: snapshot before Plexus run')) postMessage(id, 'system', 'Committed uncommitted changes in the project before starting.');
    p = updateProject(id, { mainBranch: main });
    if (!listTasks(id).length) {
      createTask(id, { title: 'Analyse documentation and goal', role: 'analyst', kind: 'ingest', priority: 100,
        description: 'Read every documentation file and the goal. Produce the project brief and acceptance criteria.' });
      updateProject(id, { phase: 'ingest' });
    }
    setProjectStatus(id, 'running');
    postMessage(id, 'system', `Plexus started (phase: ${mustProject(id).phase}).`);
    void this.tick();
    return mustProject(id);
  }

  pause(id: string) {
    setProjectStatus(id, 'paused');
    postMessage(id, 'system', 'Paused: no new tasks will start; running tasks finish their current attempt.');
  }

  resume(id: string) {
    const p = mustProject(id);
    if (p.phase === 'new' || !listTasks(id).length) return this.startProject(id);
    // Resuming a finished project means "keep working": new/remaining tasks run, then QA and evaluation again.
    if (p.status === 'completed' || p.phase.startsWith('done')) updateProject(id, { phase: 'build' });
    setProjectStatus(id, 'running');
    postMessage(id, 'system', 'Resumed.');
    void this.tick();
  }

  stop(id: string) {
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

  // ---------------- scheduler ----------------

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      releaseCooldowns();
      for (const p of listProjects()) {
        if (p.status !== 'running') continue;
        await this.advance(p.id);
        this.schedule(mustProject(p.id));
      }
    } catch (e: any) {
      bus.emitEvent('orchestrator.error', null, { message: String(e?.stack ?? e) });
    } finally { this.ticking = false; }
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

  private schedule(p: Project) {
    const all = listTasks(p.id);
    const active = all.filter(t => t.status === 'running');
    let slots = p.settings.maxParallel - active.length;
    const runnable = runnableTasks(p.id);
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
      if (!a) {
        noAccount++;
        const last = this.lastNoAccountNotice.get(p.id) ?? 0;
        if (Date.now() - last > 30 * 60_000) {
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
        if (r.project_brief) writeMemory(p, 'brief.md', r.project_brief);
        if (r.acceptance_criteria?.length) writeAcceptance(p, r.acceptance_criteria.map(a => ({ ...a, pass: null })));
        await this.finishNonCode(p, t);
        createTask(p.id, { title: 'Design architecture and project skeleton', role: 'architect', kind: 'architect', priority: 95, deps: [t.id] });
        updateProject(p.id, { phase: 'architect' });
        break;
      }
      case 'architect':
        await this.integrate(p, getTask(t.id)!);
        if (getTask(t.id)!.status === 'done') {
          createTask(p.id, { title: 'Plan implementation tasks', role: 'planner', kind: 'plan', priority: 90, deps: [t.id] });
          updateProject(p.id, { phase: 'plan' });
        }
        break;
      case 'plan': {
        await this.finishNonCode(p, t);
        this.createPlannedTasks(p, t, r.tasks?.length ? r.tasks : [{ title: 'Implement the project', description: 'Implement the whole project as described in ARCHITECTURE.md and the brief.', role: 'implementer', depends_on: [], acceptance: [], paths: [] }]);
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
      default: // build, fix, qa, custom
        if (writesCode(t)) await this.integrate(p, getTask(t.id)!);
        else await this.finishNonCode(p, t);
    }
    if (mustProject(p.id).status !== 'completed') this.createFollowUps(p, getTask(t.id)!, r);
  }

  private absorbCommon(p: Project, t: Task, a: Account, r: AgentResult) {
    for (const d of r.decisions) recordDecision(p, d, `${shortId(t)} (${t.role}, ${a.id})`);
    for (const i of r.issues) appendMemory(p, 'known-issues.md', `- [${shortId(t)}] ${i}`);
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
    const hasCommits = t.branch ? await hasCommitsAhead(p.path, t.branch, p.mainBranch) : false;
    if (!hasCommits) {
      setStatus(t.id, 'done');
      if (t.worktree) await removeWorktree(p.path, t.worktree).catch(() => {});
      this.markChainDone(t);
      return;
    }
    const needsReview = p.settings.reviewEnabled && t.kind !== 'qa' && t.kind !== 'architect';
    if (needsReview) {
      setStatus(t.id, 'in_review');
      createTask(p.id, {
        title: `Review ${shortId(t)}: ${t.title}`, role: 'reviewer', kind: 'review', parentId: t.id, priority: Math.min(99, t.priority + 5),
        authorAccountId: getTask(t.id)!.authorAccountId, reviewCycles: t.reviewCycles, paths: t.paths,
      });
    } else await this.merge(p, t);
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
    const r = await mergeBranch(p.path, p.mainBranch, t.branch, `merge ${shortId(t)}: ${t.title}`);
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
      postMessage(p.id, 'system', `Merging ${shortId(t)} failed (not a conflict): ${r.detail.slice(0, 500)}. Make sure the project's main checkout is clean and on ${p.mainBranch}.`, { level: 'attention' });
      this.pause(p.id);
      return;
    }
    const tries = listTasks(p.id).filter(x => x.kind === 'integrate' && x.parentId === t.id).length;
    if (tries >= 2) {
      setStatus(t.id, 'failed', { error: 'merge conflicts could not be resolved' });
      appendMemory(p, 'known-issues.md', `- ${shortId(t)} could not be merged (conflicts persisted after ${tries} integration attempts)`);
      return;
    }
    setStatus(t.id, 'in_review', { error: 'merge conflict' });
    createTask(p.id, {
      title: `Resolve merge conflicts for ${shortId(t)}`, role: 'integrator', kind: 'integrate', parentId: t.id,
      branch: t.branch, worktree: t.worktree, priority: 98, paths: t.paths,
      description: `Branch ${t.branch} conflicts with ${p.mainBranch}:\n${r.detail.slice(0, 1500)}`,
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
        acceptance: it.acceptance, priority: it.priority ?? 50, deps: [], paths: it.paths,
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
    // Before planning is done, suggested work goes to the planner as notes instead of becoming duplicate tasks.
    if (['ingest', 'architect', 'plan'].includes(t.kind)) {
      if (t.kind !== 'plan') appendMemory(p, 'planning-notes.md', r.follow_up_tasks.map(f => `- (${t.role}) ${f.title}: ${f.description}`).join('\n'));
      return;
    }
    let budget = p.settings.maxTasks - listTasks(p.id).length;
    for (const f of r.follow_up_tasks) {
      if (budget-- <= 0) { postMessage(p.id, 'system', `Task budget reached; follow-up "${f.title}" not created.`); break; }
      const role = f.role || 'implementer';
      createTask(p.id, { title: f.title, description: f.description, role, kind: role === 'implementer' ? 'build' : 'custom', acceptance: f.acceptance, priority: f.priority ?? 60, parentId: null, paths: f.paths });
    }
  }

  private async onEvaluate(p: Project, t: Task, r: AgentResult) {
    await this.finishNonCode(p, t);
    const ev = r.evaluation;
    if (ev) {
      const acc = readAcceptance(p);
      for (const c of ev.criteria) {
        const a = acc.find(x => x.id === c.id);
        if (a) { a.pass = c.pass; a.evidence = c.evidence; }
      }
      if (acc.length) writeAcceptance(p, acc);
    }
    const rounds = p.evalRounds + 1;
    updateProject(p.id, { evalRounds: rounds });
    const complete = !!ev?.complete;
    if (complete) return this.finish(p, ev?.report ?? r.summary, true);
    if (rounds >= p.settings.maxEvalRounds || !r.follow_up_tasks.length) {
      return this.finish(p, ev?.report ?? r.summary, false, rounds >= p.settings.maxEvalRounds ? 'evaluation round limit reached' : 'evaluator found gaps but proposed no tasks');
    }
    updateProject(p.id, { phase: 'build' });
    postMessage(p.id, 'system', `Evaluation round ${rounds}: not complete yet; ${r.follow_up_tasks.length} follow-up task(s) created.`);
  }

  private finish(p: Project, report: string, complete: boolean, why = '') {
    if (mustProject(p.id).status === 'completed') return;
    const acc = readAcceptance(p);
    const passed = acc.filter(a => a.pass).length;
    const header = `# Plexus report — ${p.name}\n\nStatus: ${complete ? 'COMPLETE' : 'STOPPED WITH GAPS' + (why ? ` (${why})` : '')}\nAcceptance: ${passed}/${acc.length} passed\nFinished: ${now()}\n\n`;
    writeFileSync(join(plexusDir(p), 'REPORT.md'), header + report);
    updateProject(p.id, { phase: complete ? 'done' : 'done-with-gaps' });
    setProjectStatus(p.id, 'completed');
    postMessage(p.id, 'system', `${complete ? 'Project complete' : 'Plexus stopped with gaps'}: acceptance ${passed}/${acc.length}. Report in .plexus/REPORT.md`, { level: 'done', report: true });
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
    if (['build'].includes(p.phase)) {
      createTask(p.id, { title: 'QA: test the integrated product', role: 'qa', kind: 'qa', priority: 80 });
      updateProject(p.id, { phase: 'qa' });
    } else if (p.phase === 'qa') {
      createTask(p.id, { title: `Evaluate against goal and acceptance criteria (round ${p.evalRounds + 1})`, role: 'evaluator', kind: 'evaluate', priority: 85 });
      updateProject(p.id, { phase: 'evaluate' });
    } else if (p.phase === 'evaluate' && listTasks(projectId).filter(t => t.kind === 'evaluate').at(-1)?.status !== 'done') {
      this.finish(p, 'The evaluation step could not be completed (see known issues).', false, 'evaluator failed');
    }
  }
}

export const orchestrator = new Orchestrator();
