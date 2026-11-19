import { join } from 'node:path';
import { CoordinatorOutputSchema, type CoordinatorAction, type CoordinatorOutput, type Task } from '../shared/types.ts';
import { applyClassification, listAccounts, runningByAccount } from './accounts.ts';
import { adapterFor } from './adapters/index.ts';
import { now } from './db.ts';
import { bus, recentEvents } from './events.ts';
import { ensure, paths } from './paths.ts';
import { appendMemory, getMessage, listMessages, mustProject, postMessage, recordDecision, updateMessageMeta, updateProject } from './projects.ts';
import { buildCoordinatorPrompt, type StatusDigest } from './prompts.ts';
import { getRole } from './roles.ts';
import { countByStatus, createTask, findTask, listTasks, shortId, updateTask } from './tasks.ts';
import { orchestrator, pickAccount } from './orchestrator.ts';

export function statusDigest(projectId: string): StatusDigest {
  const tasks = listTasks(projectId);
  const active = tasks.filter(t => !['done', 'cancelled'].includes(t.status));
  const doneRecent = tasks.filter(t => t.status === 'done').slice(-15);
  const fmt = (t: Task) => `${shortId(t)} [${t.status}] (${t.role}${t.accountId ? ` @${t.accountId}` : ''}) ${t.title}${t.deps.length ? ` deps:${t.deps.map(d => d.split('-').pop()).join(',')}` : ''}${t.error ? ` — ${t.error.slice(0, 150)}` : ''}`;
  const accounts = listAccounts().map(a => `${a.id} (${a.provider}) ${a.enabled ? a.state : 'disabled'}${a.cooldownUntil ? ` until ${a.cooldownUntil}` : ''}` +
    `${a.quota?.primary ? ` 5h:${a.quota.primary.usedPercent ?? '?'}%` : ''}${a.quota?.secondary ? ` week:${a.quota.secondary.usedPercent ?? '?'}%` : ''} running:${a.running ?? 0}`).join('\n');
  const events = recentEvents(projectId, 30).map(e => `${e.createdAt.slice(11, 19)} ${e.type} ${JSON.stringify(e.data).slice(0, 160)}`).join('\n');
  return {
    tasks: [...active.map(fmt), doneRecent.length ? `(recently done) ${doneRecent.map(t => `${shortId(t)} ${t.title}`).join('; ')}` : ''].filter(Boolean).join('\n') || '(no tasks yet)',
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

/** Apply coordinator / user actions. Returns human-readable summaries. */
export function applyActions(projectId: string, actions: CoordinatorAction[], by = 'coordinator'): string[] {
  const p = mustProject(projectId);
  const done: string[] = [];
  const task = (ref: string) => { const t = findTask(projectId, ref); if (!t) throw new Error(`unknown task ${ref}`); return t; };
  for (const a of actions) {
    try {
      switch (a.type) {
        case 'pause': orchestrator.pause(projectId); done.push('paused'); break;
        case 'resume': void orchestrator.resume(projectId); done.push('resumed'); break;
        case 'stop': orchestrator.stop(projectId); done.push('stopped'); break;
        case 'add_task': {
          const deps = a.depends_on.map(d => findTask(projectId, d)?.id).filter((x): x is string => !!x);
          const t = createTask(projectId, { title: a.title, description: a.description, role: a.role, kind: a.role === 'implementer' ? 'build' : 'custom', deps, priority: a.priority ?? 70 });
          done.push(`added ${shortId(t)} "${t.title}"`);
          if (mustProject(projectId).status === 'completed') { void orchestrator.resume(projectId); done.push('project resumed'); }
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
          for (const t of listTasks(projectId)) if (['pending', 'interrupted'].includes(t.status) && ['build', 'custom'].includes(t.kind)) { orchestrator.cancelTask(t.id); n++; }
          appendMemory(p, 'directives.md', `- Replan requested: ${a.reason} _(${now().slice(0, 16)})_`);
          createTask(projectId, { title: 'Re-plan remaining work', role: 'planner', kind: 'plan', priority: 95, description: `Re-plan the remaining work. Reason: ${a.reason}\nInspect what is already built on the main branch and plan only what is missing or must change.` });
          updateProject(projectId, { phase: 'plan' });
          done.push(`replanning (cancelled ${n} pending task(s))`);
          break;
        }
      }
    } catch (e: any) { done.push(`failed: ${a.type} — ${e?.message ?? e}`); }
  }
  return done;
}

export async function handleChat(projectId: string, text: string): Promise<void> {
  const p = mustProject(projectId);
  postMessage(projectId, 'user', text);
  const role = getRole('coordinator');
  const fake = { role: 'coordinator', kind: 'custom', status: 'pending', authorAccountId: null, lastAccountId: null } as unknown as Task;
  // Chat must stay responsive: the coordinator may share an account with a running worker
  // (a CLI account can run several sessions; they just share its quota).
  const account = pickAccount(p, fake, listAccounts().map(a => ({ ...a, running: 0 })));
  if (!account) {
    postMessage(projectId, 'system', 'No account is available to answer right now. The controls (pause/stop/resume, task actions) still work; your message is kept in the history.', { level: 'attention' });
    return;
  }
  const history = listMessages(projectId, 40).slice(0, -1);
  const prompt = buildCoordinatorPrompt(p, role, statusDigest(projectId), history, text);
  const logPath = join(ensure(join(paths.logs, projectId)), `chat-${Date.now()}-${account.id}.log`);
  runningByAccount.set(account.id, (runningByAccount.get(account.id) ?? 0) + 1);
  bus.emitEvent('chat.thinking', projectId, { account: account.id, thinking: true }, false);
  try {
    const out = await adapterFor(account.provider).run({
      account, cwd: p.path, prompt, model: role.models[account.provider], readOnly: true,
      timeoutMs: role.maxRuntimeMin * 60_000, idleTimeoutMs: 5 * 60_000, logPath,
    });
    applyClassification(account.id, out.classification, out.quota);
    const parsed = parseCoordinatorOutput(out.finalText);
    if (!parsed) {
      const why = out.classification.state !== 'ok' && out.classification.state !== 'warning' ? ` (${account.id}: ${out.classification.state})` : '';
      postMessage(projectId, 'coordinator', out.finalText.trim() || `I could not produce an answer${why}. Please try again.`, { account: account.id });
      return;
    }
    const applied = applyActions(projectId, parsed.actions);
    const meta: Record<string, unknown> = { account: account.id, applied };
    if (parsed.proposal?.actions.length) meta.proposal = { ...parsed.proposal, status: 'pending' };
    postMessage(projectId, 'coordinator', parsed.reply, meta);
  } finally {
    runningByAccount.set(account.id, Math.max(0, (runningByAccount.get(account.id) ?? 1) - 1));
    bus.emitEvent('chat.thinking', projectId, { account: account.id, thinking: false }, false);
  }
}

export function resolveProposal(messageId: number, approve: boolean): string[] {
  const m = getMessage(messageId);
  const prop = m?.meta?.proposal as { summary: string; actions: CoordinatorAction[]; status: string } | undefined;
  if (!m || !prop) throw new Error('no proposal on this message');
  if (prop.status !== 'pending') throw new Error(`proposal already ${prop.status}`);
  const applied = approve ? applyActions(m.projectId, prop.actions, 'approved proposal') : [];
  updateMessageMeta(m.id, { ...m.meta, proposal: { ...prop, status: approve ? 'approved' : 'rejected', applied } });
  postMessage(m.projectId, 'system', approve ? `Proposal approved: ${applied.join('; ')}` : 'Proposal rejected.');
  return applied;
}
