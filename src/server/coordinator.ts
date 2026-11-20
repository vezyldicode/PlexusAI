import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoordinatorOutputSchema, type CoordinatorAction, type CoordinatorOutput, type Project, type Task } from '../shared/types.ts';
import { applyClassification, getAccount, listAccounts, runningByAccount } from './accounts.ts';
import { adapterFor } from './adapters/index.ts';
import type { McpServerSpec } from './adapters/types.ts';
import { addUsage } from './usage.ts';
import { autoTitle, defaultSession, mustSession, setCliSession } from './chat.ts';
import { now } from './db.ts';
import { effortForRun } from './models.ts';
import { bus, recentEvents } from './events.ts';
import { appRoot, ensure, paths } from './paths.ts';
import {
  appendMemory, getMessage, listMessages, messagesAfter, mustProject, postMessage, recordDecision, removeDirectives, updateMessageMeta, updateProject,
} from './projects.ts';
import { buildCoordinatorPrompt, buildCoordinatorTurnPrompt, type StatusDigest } from './prompts.ts';
import { getRole } from './roles.ts';
import { runtime } from './runtime.ts';
import { countByStatus, createTask, findTask, listTasks, shortId, updateTask } from './tasks.ts';
import { orchestrator, pickAccount } from './orchestrator.ts';
import { addWorktree, commitAll, git, hasCommitsAhead } from './util/git.ts';
import { LANE_CTX_MAX, resumeWorthIt } from './worker.ts';

/**
 * The project state for the coordinator. With `since` (the time of its last reply in a resumed conversation) only what
 * changed: active tasks (short), tasks that finished since, and new events; the rest is already in its conversation.
 */
export function statusDigest(projectId: string, since?: string | null): StatusDigest {
  const tasks = listTasks(projectId);
  const active = tasks.filter(t => !['done', 'cancelled'].includes(t.status));
  const fmt = (t: Task) => `${shortId(t)} [${t.status}] (${t.role}${t.accountId ? ` @${t.accountId}` : ''}${t.pinnedAccountId ? ` pin:${t.pinnedAccountId}` : ''}) ${t.title}` +
    `${t.deps.length ? ` deps:${t.deps.map(d => d.split('-').pop()).join(',')}` : ''}${t.paths.length ? ` paths:${t.paths.slice(0, 4).join(',')}` : ''}${t.error ? ` — ${t.error.slice(0, 150)}` : ''}`;
  const accounts = listAccounts().map(a => `${a.id} (${a.provider}) ${a.enabled ? a.state : 'disabled'}${a.cooldownUntil ? ` until ${a.cooldownUntil}` : ''}` +
    `${a.quota?.primary ? ` 5h:${a.quota.primary.usedPercent ?? '?'}%` : ''}${a.quota?.secondary ? ` week:${a.quota.secondary.usedPercent ?? '?'}%` : ''} running:${a.running ?? 0}`).join('\n');
  const evs = recentEvents(projectId, 30).filter(e => !since || e.createdAt > since);
  const events = evs.map(e => `${e.createdAt.slice(11, 19)} ${e.type} ${JSON.stringify(e.data).slice(0, 160)}`).join('\n');
  const finished = tasks.filter(t => ['done', 'cancelled'].includes(t.status) && (!since || t.updatedAt > since));
  const done = since ? finished : finished.filter(t => t.status === 'done').slice(-15);
  const doneLine = done.length ? `(${since ? 'finished since' : 'recently done'}) ${done.map(t => `${shortId(t)} [${t.status}] ${t.title}${t.result?.summary ? ` — ${t.result.summary.slice(0, 200)}` : ''}`).join('; ')}` : '';
  return {
    tasks: [...active.map(fmt), doneLine].filter(Boolean).join('\n') || '(no tasks yet)',
    accounts: accounts || '(no accounts)',
    events: events || '(none)',
    counts: JSON.stringify(countByStatus(projectId)),
  };
}

export function parseCoordinatorOutput(text: string): CoordinatorOutput | null {
  const candidates = [text.trim()];
  const block = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  candidates.push(...block);
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  for (const c of candidates) {
    try {
      const r = CoordinatorOutputSchema.safeParse(JSON.parse(c));
      if (r.success) return r.data;
    } catch { /* next */ }
  }
  return null;
}

/** The single agent a new chat request can continue: the last solo task, if its conversation is still cheap to resume. */
function soloLane(projectId: string): Task | null {
  const last = listTasks(projectId).filter(t => t.kind === 'solo' && t.status === 'done' && t.cliSessionId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return last && resumeWorthIt(last.cliCtxTokens, last.cliUsedAt) ? last : null;
}

const accountRef = (ref: string) => {
  if (!ref || ref === 'auto') return null;
  const a = getAccount(ref) ?? listAccounts().find(x => x.label === ref);
  if (!a) throw new Error(`unknown account ${ref}`);
  return a.id;
};

/** Apply coordinator / user actions. Returns human-readable summaries. */
export function applyActions(projectId: string, actions: CoordinatorAction[], by = 'coordinator', sessionId?: string | null): string[] {
  const p = mustProject(projectId);
  const done: string[] = [];
  const task = (ref: string) => { const t = findTask(projectId, ref); if (!t) throw new Error(`unknown task ${ref}`); return t; };
  for (const a of actions) {
    try {
      switch (a.type) {
        case 'pause': orchestrator.pause(projectId, sessionId); done.push('paused'); break;
        case 'resume': void orchestrator.resume(projectId, sessionId); done.push('resumed'); break;
        case 'stop': orchestrator.stop(projectId, sessionId); done.push('stopped'); break;
        case 'add_task': {
          const deps = a.depends_on.map(d => findTask(projectId, d)?.id).filter((x): x is string => !!x);
          const t = createTask(projectId, { title: a.title, description: a.description, role: a.role, kind: a.role === 'implementer' ? 'build' : 'custom', deps, priority: a.priority ?? 70, originSessionId: sessionId });
          done.push(`added ${shortId(t)} "${t.title}"`);
          if (mustProject(projectId).status === 'completed') { void orchestrator.resume(projectId, sessionId); done.push('project resumed'); }
          break;
        }
        case 'solo_task': {
          // One agent on the coordinator's model, outside the project pipeline. It continues the last single agent when
          // that one is still cheap to resume (it knows the code already), unless asked for a fresh one.
          const lane = a.fresh ? null : soloLane(projectId);
          const pin = a.account ? accountRef(a.account) : null;
          const t = createTask(projectId, { title: a.title, description: a.description, role: 'solo', kind: 'solo', priority: 75, originSessionId: sessionId, adhoc: true, laneFrom: lane, pinnedAccountId: pin });
          done.push(`${shortId(t)} "${t.title}" started (single agent${t.laneFrom && lane ? `, continuing ${shortId(lane)}'s conversation` : ''})`);
          void orchestrator.tick();
          break;
        }
        case 'continue_task': {
          const prev = task(a.task_id);
          const t = orchestrator.continueTask(prev.id, a.instructions, a.title, sessionId);
          done.push(t.id === prev.id ? `message queued for ${shortId(prev)} (still active)` : `${shortId(t)} continues ${shortId(prev)}${t.laneFrom ? ' in its conversation' : ''}`);
          break;
        }
        case 'send_message': { const t = task(a.task_id); orchestrator.sendMessage(t.id, a.text); done.push(`message for ${shortId(t)} queued`); break; }
        case 'assign_account': {
          const t = task(a.task_id);
          const id = accountRef(a.account);
          updateTask(t.id, { pinnedAccountId: id });
          done.push(id ? `${shortId(t)} pinned to ${id}` : `${shortId(t)} unpinned`);
          void orchestrator.tick();
          break;
        }
        case 'remove_directive': {
          const gone = removeDirectives(p, a.match);
          done.push(gone.length ? `removed ${gone.length} directive(s)` : `no directive matched "${a.match}"`);
          break;
        }
        case 'cancel_task': { const t = task(a.task_id); orchestrator.cancelTask(t.id); done.push(`cancelled ${shortId(t)}`); break; }
        case 'retry_task': { const t = task(a.task_id); orchestrator.retryTask(t.id); done.push(`retrying ${shortId(t)}`); break; }
        case 'reprioritize': { const t = task(a.task_id); updateTask(t.id, { priority: a.priority }); done.push(`${shortId(t)} priority → ${a.priority}`); break; }
        case 'update_task': { const t = task(a.task_id); updateTask(t.id, { description: a.description }); done.push(`updated ${shortId(t)}`); break; }
        case 'record_decision': recordDecision(p, a, `user via ${by}`); done.push(`decision "${a.title}" recorded`); break;
        case 'add_directive': appendMemory(p, 'directives.md', `- ${a.text} _(${now().slice(0, 16)})_`); done.push('directive added'); break;
        case 'set_goal': updateProject(projectId, { goal: a.goal }); done.push('goal updated'); break;
        case 'replan': {
          let n = 0;
          for (const t of listTasks(projectId)) if (['pending', 'interrupted', 'blocked'].includes(t.status) && ['build', 'custom'].includes(t.kind)) { orchestrator.cancelTask(t.id); n++; }
          appendMemory(p, 'directives.md', `- Replan requested: ${a.reason} _(${now().slice(0, 16)})_`);
          createTask(projectId, { title: 'Re-plan remaining work', role: 'planner', kind: 'plan', priority: 95, originSessionId: sessionId, description: `Re-plan the remaining work. Reason: ${a.reason}\nInspect what is already built on the main branch and plan only what is missing or must change.` });
          updateProject(projectId, { phase: 'plan' });
          done.push(`replanning (cancelled ${n} pending task(s))`);
          break;
        }
      }
    } catch (e: any) { done.push(`failed: ${a.type} — ${e?.message ?? e}`); }
  }
  return done;
}

// ---------------- the coordinator's own edits ----------------

/** Start editing the main checkout: merges wait until plexus_main_commit (or 10 minutes). */
export async function beginMainEdit(projectId: string): Promise<string> {
  const p = mustProject(projectId);
  await orchestrator.holdMain(p.id);
  const st = (await git(p.path, 'status', '--short')).stdout.trim();
  return `Merges into ${p.mainBranch} are held until plexus_main_commit (10 min at most). You may edit ${p.path} now.` +
    (st ? `\nAlready uncommitted there (possibly the user's own work: leave it alone):\n${st}` : '');
}

/** Commit the coordinator's edits in the main checkout and let merges continue. */
export async function commitMainEdit(projectId: string, message: string): Promise<string> {
  const p = mustProject(projectId);
  try {
    const ok = await commitAll(p.path, message.trim() || 'chore: coordinator edit');
    return ok ? `Committed on ${p.mainBranch}: ${(await git(p.path, 'log', '--oneline', '-1')).stdout.trim()}` : 'Nothing to commit.';
  } finally { orchestrator.releaseMain(p.id); }
}

const COORD_BRANCH = 'plexus/coordinator';
const coordWorktree = (p: Project) => join(ensure(join(paths.worktrees, p.id)), 'coordinator');

/** The coordinator's own worktree for larger edits, on its branch, fresh from the main branch when nothing is pending. */
export async function coordinatorWorkspace(projectId: string): Promise<string> {
  const p = mustProject(projectId);
  const wt = coordWorktree(p);
  if (!existsSync(wt)) await addWorktree(p.path, wt, { branch: COORD_BRANCH, newBranchFrom: p.mainBranch });
  else if (!(await hasCommitsAhead(p.path, COORD_BRANCH, p.mainBranch)) && !(await git(wt, 'status', '--porcelain')).stdout.trim()) {
    await git(wt, 'reset', '--hard', p.mainBranch);
  }
  return `Your worktree: ${wt} (branch ${COORD_BRANCH}). Edit and test there, then call plexus_workspace_merge.`;
}

/** Commit the coordinator's worktree and merge it into the main branch through the merge queue. */
export async function mergeCoordinatorWorkspace(projectId: string, message: string): Promise<string> {
  const p = mustProject(projectId);
  const wt = coordWorktree(p);
  if (!existsSync(wt)) return 'No coordinator worktree: call plexus_workspace first.';
  await commitAll(wt, message.trim() || 'chore: coordinator change');
  if (!(await hasCommitsAhead(p.path, COORD_BRANCH, p.mainBranch))) return 'Nothing to merge.';
  const r = await orchestrator.mergeCoordinatorBranch(p, COORD_BRANCH, `merge coordinator: ${message.trim() || 'change'}`);
  if (r.ok) await git(wt, 'reset', '--hard', p.mainBranch);
  return r.ok ? `Merged into ${p.mainBranch}.` : `Not merged (${r.detail.slice(0, 800)}). Resolve it in your worktree (git merge ${p.mainBranch}) and try again.`;
}

// ---------------- chat ----------------

/** One answer at a time per chat session: a resumed CLI conversation must not get two turns at once. */
const chatLocks = new Map<string, Promise<unknown>>();

export async function handleChat(projectId: string, text: string, sessionId?: string | null): Promise<void> {
  mustProject(projectId);
  const session = sessionId ? mustSession(sessionId) : defaultSession(projectId);
  if (session.projectId !== projectId) throw new Error('chat session belongs to another project');
  const userMsg = postMessage(projectId, 'user', text, null, session.id);
  autoTitle(session.id, text);
  const run = (chatLocks.get(session.id) ?? Promise.resolve()).catch(() => {}).then(() => answer(projectId, session.id, userMsg.id, text));
  chatLocks.set(session.id, run);
  try { await run; } finally { if (chatLocks.get(session.id) === run) chatLocks.delete(session.id); }
}

/** The account the coordinator would answer the next message on, and with which model/effort setting. */
export function coordinatorTarget(p: Project) {
  const role = getRole('coordinator');
  const fake = { role: 'coordinator', kind: 'custom', status: 'pending', authorAccountId: null, lastAccountId: null, pinnedAccountId: null, cliAccountId: null } as unknown as Task;
  // Chat must stay responsive: the coordinator may share an account with a running worker
  // (a CLI account can run several sessions; they just share its quota).
  const accounts = listAccounts().map(a => ({ ...a, running: 0 }));
  const pinnedId = p.settings.coordinatorAccountId;
  // A pinned account is used whenever it can run; otherwise fall back to automatic selection.
  const pinned = pinnedId ? pickAccount(p, fake, accounts.filter(a => a.id === pinnedId)) : null;
  const account = pinned ?? pickAccount(p, fake, accounts);
  const model = account ? p.settings.coordinatorModels?.[account.provider] || role.models[account.provider] : undefined;
  const effort = account ? p.settings.coordinatorEfforts?.[account.provider] || role.efforts?.[account.provider] : undefined;
  return { role, accounts, pinnedId, pinned, account, model, effort };
}

/** The `plexus` MCP server the coordinator's CLI starts (it calls back into this daemon's API). */
export function coordinatorMcp(projectId: string, sessionId: string): McpServerSpec | undefined {
  if (!runtime.port || !runtime.token) return undefined;
  return {
    name: 'plexus', command: process.execPath, args: [join(appRoot, 'src', 'server', 'mcp', 'plexus-mcp.ts')],
    env: {
      PLEXUS_API: `http://127.0.0.1:${runtime.port}`, PLEXUS_TOKEN: runtime.token, PLEXUS_PROJECT: projectId, PLEXUS_SESSION: sessionId,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  };
}

async function answer(projectId: string, sessionId: string, userMsgId: number, text: string): Promise<void> {
  const p = mustProject(projectId);
  const say = (author: 'system' | 'coordinator', body: string, meta: Record<string, unknown> | null = null) => postMessage(projectId, author, body, meta, sessionId);
  const { role, accounts, pinnedId, pinned, account, model, effort } = coordinatorTarget(p);
  if (pinnedId && !pinned && account) {
    const a = accounts.find(x => x.id === pinnedId);
    say('system', `${a ? `${a.label || a.id} is ${a.enabled ? a.state : 'disabled'}` : `Account ${pinnedId} no longer exists`}; the coordinator answers on ${account.label || account.id} instead.`);
  }
  if (!account) {
    say('system', 'No account is available to answer right now. The controls (pause/stop/resume, task actions) still work; your message is kept in the history.', { level: 'attention' });
    return;
  }
  const eff = await effortForRun(account, model, effort);
  if (eff.warning) say('system', `Coordinator: ${eff.warning}.`);

  // Continue the provider CLI conversation when it belongs to this very account (its history lives in the account's home)
  // and has not grown too large; otherwise start one with the recent chat history of this session in the prompt.
  const session = mustSession(sessionId);
  const mcp = coordinatorMcp(projectId, sessionId);
  const tools = !!mcp;
  const lastReply = listMessages(projectId, 40, sessionId).filter(m => m.author === 'coordinator' && m.id < userMsgId).at(-1);
  const lastCtx = Number((lastReply?.meta?.tokens as any)?.lastCtx ?? 0);
  const fullPrompt = () => buildCoordinatorPrompt(p, role, statusDigest(projectId), listMessages(projectId, 40, sessionId).filter(m => m.id < userMsgId), text, tools);
  const deltaPrompt = () => buildCoordinatorTurnPrompt(p, statusDigest(projectId, lastReply?.createdAt ?? null),
    messagesAfter(sessionId, session.cliSyncedMessageId, userMsgId).filter(m => !(m.author === 'coordinator' && m.meta?.cli)), text, tools);
  const attempt = (resumeId: string | undefined, tag: string) => {
    const logPath = join(ensure(join(paths.logs, projectId)), `chat-${Date.now()}-${account.id}${tag}.log`);
    const prompt = resumeId ? deltaPrompt() : fullPrompt();
    // The prompt heads the log (the CLI's stream follows), and the user's message points to it: the chat shows it on demand.
    writeFileSync(logPath, `# prompt${resumeId ? ` (resuming ${resumeId})` : ''} (${now()})\n${prompt}\n\n# output\n`);
    const um = getMessage(userMsgId);
    if (um) updateMessageMeta(userMsgId, { ...(um.meta ?? {}), promptLog: logPath, promptChars: prompt.length, promptResumed: !!resumeId });
    // The coordinator works in the project folder with full permissions (read, edit, run) and the plexus tools.
    return adapterFor(account.provider).run({
      account, cwd: p.path, prompt, resumeId, model, effort: eff.effort, readOnly: false,
      mcp, autocompact: p.settings.autocompactTokens, timeoutMs: role.maxRuntimeMin * 60_000, idleTimeoutMs: 5 * 60_000, logPath,
    });
  };

  runningByAccount.set(account.id, (runningByAccount.get(account.id) ?? 0) + 1);
  bus.emitEvent('chat.thinking', projectId, { account: account.id, thinking: true, sessionId }, false);
  try {
    const sameCli = session.cliSessionId && session.cliAccountId === account.id;
    const tooBig = lastCtx > LANE_CTX_MAX;
    const resumeId = sameCli && !tooBig ? session.cliSessionId! : undefined;
    let out = await attempt(resumeId, resumeId ? '-resume' : '');
    // The CLI no longer knows the conversation (purged, other machine...): start over from this session's history.
    const lostCli = !!resumeId && out.classification.state === 'task_error';
    if (lostCli) { const failed = out.usage; out = await attempt(undefined, ''); out.usage = addUsage(failed, out.usage); }
    applyClassification(account.id, out.classification, out.quota);
    const usable = ['ok', 'warning'].includes(out.classification.state);
    if (usable && out.sessionId) setCliSession(sessionId, { sessionId: out.sessionId, accountId: account.id, syncedMessageId: userMsgId });
    else if (lostCli) setCliSession(sessionId, null);

    const parsed = parseCoordinatorOutput(out.finalText);
    const meta: Record<string, unknown> = { account: account.id, model, effort: eff.effort ?? null, tokens: out.usage, cli: usable && !!out.sessionId, resumed: !!resumeId && !lostCli, tools, ...(tooBig && sameCli ? { freshContext: true } : {}) };
    if (!parsed) {
      const why = !usable ? ` (${account.id}: ${out.classification.state})` : '';
      say('coordinator', out.finalText.trim() || `I could not produce an answer${why}. Please try again.`, meta);
      return;
    }
    const applied = applyActions(projectId, parsed.actions, 'coordinator', sessionId);
    meta.applied = applied;
    if (parsed.proposal?.actions.length) meta.proposal = { ...parsed.proposal, status: 'pending' };
    say('coordinator', parsed.reply, meta);
  } finally {
    runningByAccount.set(account.id, Math.max(0, (runningByAccount.get(account.id) ?? 1) - 1));
    bus.emitEvent('chat.thinking', projectId, { account: account.id, thinking: false, sessionId }, false);
  }
}

export function resolveProposal(messageId: number, approve: boolean): string[] {
  const m = getMessage(messageId);
  const prop = m?.meta?.proposal as { summary: string; actions: CoordinatorAction[]; status: string } | undefined;
  if (!m || !prop) throw new Error('no proposal on this message');
  if (prop.status !== 'pending') throw new Error(`proposal already ${prop.status}`);
  const applied = approve ? applyActions(m.projectId, prop.actions, 'approved proposal', m.sessionId) : [];
  updateMessageMeta(m.id, { ...m.meta, proposal: { ...prop, status: approve ? 'approved' : 'rejected', applied } });
  postMessage(m.projectId, 'system', approve ? `Proposal approved: ${applied.join('; ')}` : 'Proposal rejected.', null, m.sessionId);
  return applied;
}
