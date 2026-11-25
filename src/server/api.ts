import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdtempSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Provider } from '../shared/types.ts';
import { addAccount, getAccount, listAccounts, openLogin, probeAccount, removeAccount, updateAccount } from './accounts.ts';
import { syncBranch, unwatchBranch } from './branch.ts';
import { createSession, defaultSession, deleteSession, listSessions, markRead, mustSession, updateSession } from './chat.ts';
import { applyActions, beginMainEdit, commitMainEdit, coordinatorTarget, coordinatorWorkspace, handleChat, mergeCoordinatorWorkspace, resolveProposal, statusDigest } from './coordinator.ts';
import { bus, recentEvents } from './events.ts';
import { orchestrator } from './orchestrator.ts';
import { appRoot } from './paths.ts';
import {
  createProject, deleteProject, folderProblem, getMessage, moveProject, postMessage, getProject, listMessages, listProjects, MEMORY_FILES, mustProject, readAcceptance, readMemory, plexusDir,
  updateProject, writeMemory,
} from './projects.ts';
import { deleteRole, listRoles, resetRole, saveRole } from './roles.ts';
import { createSkill, deleteSkill, installSkill, listSkills, removeTemp, setSkillEnabled, skillFiles } from './skills.ts';
import { countByStatus, findTask, getTask, listRuns, listTasks, shortId, updateTask } from './tasks.ts';
import type { Run } from '../shared/types.ts';
import { projectUsage } from './usage.ts';
import { readLogTurns, turnMessages } from './runlog.ts';
import { taskModelInfo } from './worker.ts';
import { describeClaudeEvent } from './adapters/claude.ts';
import { describeCodexEvent } from './adapters/codex.ts';
import { cleanEfforts, modelCatalog } from './models.ts';
import { appConfig, configOverrides, projectDefaults, updateConfig, updateProjectDefaults } from './config.ts';
import { DEFAULT_APP_CONFIG, CONFIG_BOUNDS } from '../shared/config.ts';
import { DEFAULT_PROJECT_SETTINGS } from '../shared/types.ts';
import { chooseFolder } from './folder-picker.ts';
import { saveImages } from './attachments.ts';
import { completeOnboarding, loginStatus, onboardingState, openInstall, setupChecks, INSTALL_COMMANDS, type InstallTool } from './setup.ts';

/** The prompt section at the head of a run log (written by the worker before the "# output" marker). */
function promptOf(path: string, maxBytes = 400_000): string {
  if (!existsSync(path)) return '';
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(maxBytes, statSync(path).size));
    readSync(fd, buf, 0, buf.length, 0);
    const s = buf.toString('utf8');
    const end = s.indexOf('\n# output\n');
    return (end < 0 ? s : s.slice(0, end)).replace(/^# prompt \([^)]*\)\n/, '');
  } finally { closeSync(fd); }
}

const cleanModels = (m: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(m).filter(([k, v]) => ['claude', 'codex', 'mock'].includes(k) && typeof v === 'string' && v.trim()).map(([k, v]) => [k, String(v).trim()]));

function tailFile(path: string, maxBytes = 200_000): string {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return (start ? '…(truncated)\n' : '') + buf.toString('utf8');
  } finally { closeSync(fd); }
}

const describerOf = (accountId: string) => ((getAccount(accountId)?.provider ?? (accountId.startsWith('codex') ? 'codex' : 'claude')) === 'codex' ? describeCodexEvent : describeClaudeEvent);

/** A CLI stream as readable lines (messages, tool calls, status). */
function streamEvents(accountId: string, out: string): { kind: string; text: string }[] {
  const describe = describerOf(accountId);
  return out.split('\n').filter(Boolean).map(l => describe(l)).filter((e): e is NonNullable<typeof e> => !!e && e.kind !== 'raw');
}

/** The agent stream of a run as readable lines (messages, tool calls, status). */
function runEvents(run: Run): { kind: string; text: string }[] {
  const log = tailFile(run.logPath);
  const marker = log.indexOf('\n# output\n');
  return streamEvents(run.accountId, marker < 0 ? log : log.slice(marker + '\n# output\n'.length));
}

export async function buildApi(token: string, hooks: { shutdown: () => Promise<void>; chooseFolder?: () => Promise<string | null> } = { shutdown: async () => {} }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 75 * 1024 * 1024 });
  await app.register(websocket);
  // Accept empty JSON bodies (POST /start etc. are sent with a JSON content type and no body).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, raw, done) => {
    try { done(null, raw ? JSON.parse(String(raw)) : {}); } catch (e: any) { e.statusCode = 400; done(e, undefined); }
  });

  const check = (supplied: string | undefined) => {
    if (!supplied) return false;
    const a = Buffer.from(supplied), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/health') return;
    const q = (req.query as any)?.token as string | undefined;
    if (!check((req.headers['x-plexus-token'] as string | undefined) ?? q)) return reply.code(401).send({ error: 'unauthorized' });
  });

  app.setErrorHandler((err: any, _req, reply) => { reply.code(err?.statusCode ?? 400).send({ error: String(err?.message ?? err) }); });

  const id = (req: FastifyRequest) => (req.params as any).id as string;
  const body = (req: FastifyRequest) => (req.body ?? {}) as any;

  app.get('/api/health', async () => ({ ok: true, app: 'plexus' }));
  // Graceful stop (running agents are interrupted and resume on next start).
  app.post('/api/shutdown', async () => {
    setTimeout(() => { void hooks.shutdown().finally(() => process.exit(0)); }, 200);
    return { ok: true };
  });

  // ---- first-run setup
  app.get('/api/setup', async () => onboardingState());
  app.post('/api/setup/check', async () => setupChecks());
  app.post('/api/setup/complete', async req => completeOnboarding(!!body(req).skipped));
  app.post('/api/setup/install', async (req, reply) => {
    const tool = String(body(req).tool ?? '') as InstallTool;
    if (!(tool in INSTALL_COMMANDS)) return reply.code(400).send({ error: 'unknown tool' });
    return openInstall(tool);
  });

  // ---- accounts
  app.get('/api/accounts', async () => listAccounts());
  app.post('/api/accounts', async req => {
    const b = body(req);
    if (!['claude', 'codex', 'mock'].includes(b.provider)) throw new Error('provider must be claude, codex or mock');
    return addAccount({ provider: b.provider as Provider, label: b.label, id: b.id || undefined, home: b.home || undefined, maxConcurrency: b.maxConcurrency, priority: b.priority });
  });
  app.patch('/api/accounts/:id', async req => updateAccount(id(req), body(req)));
  app.delete('/api/accounts/:id', async req => { removeAccount(id(req)); return { ok: true }; });
  app.post('/api/accounts/:id/login', async req => openLogin(id(req)));
  app.post('/api/accounts/:id/probe', async req => probeAccount(id(req)));
  app.post('/api/accounts/:id/login-status', async req => loginStatus(id(req)));
  // Re-check every enabled account (state + quota) in parallel; one failing account doesn't stop the others.
  app.post('/api/accounts/probe', async () => {
    const enabled = listAccounts().filter(a => a.enabled);
    const results = await Promise.allSettled(enabled.map(a => probeAccount(a.id)));
    const failed = results.flatMap((r, i) => r.status === 'rejected' ? [{ id: enabled[i].id, error: String(r.reason?.message ?? r.reason) }] : []);
    return { probed: enabled.length, failed, accounts: listAccounts() };
  });
  // Models and efforts offered by the enabled accounts' CLIs (cached 12 h; ?refresh=1 re-reads them).
  app.get('/api/models', async req => modelCatalog(listAccounts(), ['1', 'true'].includes(String((req.query as any)?.refresh ?? ''))));

  // ---- projects
  app.post('/api/folder-picker', async () => ({ path: await (hooks.chooseFolder ?? chooseFolder)() }));
  // Both loads read the folder's branch first, so a reload shows the branch that is checked out now.
  app.get('/api/projects', async () => { for (const p of listProjects()) syncBranch(p.id); return listProjects().map(p => ({ ...p, counts: countByStatus(p.id), folderMissing: !!folderProblem(p) })); });
  app.post('/api/projects', async req => {
    const b = body(req);
    if (!b.path) throw new Error('path is required');
    const p = createProject({ path: b.path, name: b.name, goal: b.goal, settings: b.settings });
    if (b.start) await orchestrator.startProject(p.id, b.sessionId);
    return getProject(p.id);
  });
  app.get('/api/projects/:id', async req => {
    syncBranch(id(req));
    const p = mustProject(id(req));
    const tasks = listTasks(p.id);
    return {
      project: p, tasks, counts: countByStatus(p.id), acceptance: readAcceptance(p), waiting: orchestrator.waiting.get(p.id) ?? null, usage: projectUsage(p.id),
      models: Object.fromEntries(tasks.map(t => [t.id, taskModelInfo(p, t)])),
    };
  });
  app.patch('/api/projects/:id', async req => {
    const b = body(req);
    const st = b.settings && typeof b.settings === 'object' ? { ...b.settings } : undefined;
    if (st && 'coordinatorAccountId' in st) {
      const acc = st.coordinatorAccountId ? String(st.coordinatorAccountId) : null;
      if (acc && !listAccounts().some(a => a.id === acc)) throw new Error(`unknown account ${acc}`);
      st.coordinatorAccountId = acc;
    }
    if (st && 'coordinatorModels' in st) st.coordinatorModels = st.coordinatorModels && typeof st.coordinatorModels === 'object' ? cleanModels(st.coordinatorModels) : {};
    if (st && 'coordinatorEfforts' in st) st.coordinatorEfforts = st.coordinatorEfforts && typeof st.coordinatorEfforts === 'object' ? cleanEfforts(st.coordinatorEfforts) : {};
    return updateProject(id(req), { ...b, ...(st && { settings: st }) });
  });
  // Engine settings (Settings → Quota, Scheduler, Context, Coordinator, Advanced) and the defaults of new projects.
  const configView = () => ({ config: appConfig(), overrides: configOverrides(), defaults: DEFAULT_APP_CONFIG, bounds: CONFIG_BOUNDS,
    projectDefaults: projectDefaults(), projectBuiltin: DEFAULT_PROJECT_SETTINGS });
  app.get('/api/config', async () => configView());
  app.patch('/api/config', async req => { updateConfig(body(req)); return configView(); });
  app.patch('/api/config/project-defaults', async req => { updateProjectDefaults(body(req)); return configView(); });
  app.delete('/api/projects/:id', async req => { orchestrator.stop(id(req)); unwatchBranch(id(req)); deleteProject(id(req)); return { ok: true }; });
  // Point the project at another folder (Edit project in the sidebar). Same project, same history: only the path changes.
  app.post('/api/projects/:id/folder', async req => {
    const r = moveProject(id(req), String(body(req).path ?? ''));
    if (r.from === r.project.path) return r;
    syncBranch(r.project.id);
    const memory = r.memory === 'copied' ? ' Memory (.plexus) was copied from the old folder.'
      : r.memory === 'not_found' ? ' The old folder is gone, so its memory (.plexus) could not be copied; the new folder starts with the goal only.' : '';
    postMessage(r.project.id, 'system', `Project folder changed from ${r.from} to ${r.project.path}.${memory} The coordinator starts a fresh conversation in the new folder.`);
    return { ...r, project: mustProject(r.project.id) };
  });
  // Open the project folder in the system file manager (the daemon runs on the user's own machine).
  app.post('/api/projects/:id/reveal', async req => {
    const p = mustProject(id(req));
    if (!existsSync(p.path)) throw new Error(`folder not found: ${p.path}`);
    const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [p.path]] : process.platform === 'darwin' ? ['open', [p.path]] : ['xdg-open', [p.path]];
    spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => {}).unref();
    return { ok: true };
  });
  app.post('/api/projects/:id/start', async req => orchestrator.startProject(id(req), body(req).sessionId));
  app.post('/api/projects/:id/pause', async req => { orchestrator.pause(id(req), body(req).sessionId); return mustProject(id(req)); });
  app.post('/api/projects/:id/resume', async req => { await orchestrator.resume(id(req), body(req).sessionId); return mustProject(id(req)); });
  app.post('/api/projects/:id/stop', async req => { orchestrator.stop(id(req), body(req).sessionId); return mustProject(id(req)); });
  app.post('/api/projects/:id/actions', async req => ({ applied: applyActions(id(req), body(req).actions ?? [], body(req).by === 'coordinator' ? 'coordinator' : 'user', body(req).sessionId) }));

  // ---- coordinator tools (the plexus MCP server calls these)
  app.get('/api/projects/:id/status-digest', async req => {
    const p = mustProject(id(req));
    const s = statusDigest(p.id);
    return { text: `Project ${p.name} · status: ${p.status} · phase: ${p.phase} · main branch: ${p.mainBranch}\nTask counts: ${s.counts}\n\n## Tasks\n${s.tasks}\n\n## Accounts\n${s.accounts}\n\n## Recent events\n${s.events}` };
  });
  const taskRef = (req: FastifyRequest) => {
    const t = findTask(id(req), String((req.params as any).ref));
    if (!t) throw new Error(`unknown task ${(req.params as any).ref}`);
    return t;
  };
  app.get('/api/projects/:id/tasks/:ref', async req => {
    const t = taskRef(req);
    const runs = listRuns(t.id).map(r => ({ id: r.id, account: r.accountId, startedAt: r.startedAt, endedAt: r.endedAt, outcome: r.outcome, tokens: r.usage?.total ?? null, maxCtx: r.usage?.maxCtx ?? null, log: r.logPath }));
    const { result, ...rest } = t;
    return { task: { ...rest, id: shortId(t), laneFrom: t.laneFrom ? `T${t.laneFrom.split('-T').pop()}` : null }, result, runs };
  });
  app.get('/api/projects/:id/tasks/:ref/events', async req => {
    const t = taskRef(req);
    const q = req.query as any;
    const runs = listRuns(t.id);
    const run = runs.find(r => r.id === Number(q.run ?? 0)) ?? runs.at(-1);
    if (!run) return { header: `${shortId(t)} has not run yet.`, lines: [] };
    const grep = String(q.grep ?? '').toLowerCase();
    const lines = runEvents(run).map(e => `[${e.kind}] ${e.text.replace(/\s+/g, ' ').slice(0, 600)}`).filter(l => !grep || l.toLowerCase().includes(grep));
    const tail = Math.max(1, Math.min(2000, Number(q.tail ?? 120) || 120));
    return { header: `${shortId(t)} run ${run.id} on ${run.accountId} (${run.outcome ?? 'running'}), log: ${run.logPath}${lines.length > tail ? ` — last ${tail} of ${lines.length} lines` : ''}`, lines: lines.slice(-tail) };
  });
  app.post('/api/projects/:id/main/begin', async req => ({ text: await beginMainEdit(id(req)) }));
  app.post('/api/projects/:id/main/commit', async req => ({ text: await commitMainEdit(id(req), String(body(req).message ?? ''), body(req).sessionId ?? null) }));
  app.post('/api/projects/:id/coordinator-workspace', async req => ({ text: await coordinatorWorkspace(id(req)) }));
  app.post('/api/projects/:id/coordinator-workspace/merge', async req => ({ text: await mergeCoordinatorWorkspace(id(req), String(body(req).message ?? ''), body(req).sessionId ?? null) }));
  app.get('/api/projects/:id/memory', async req => {
    const p = mustProject(id(req));
    return Object.fromEntries(MEMORY_FILES.map(f => [f, readMemory(p, f)]));
  });
  app.put('/api/projects/:id/memory/:file', async req => {
    const file = (req.params as any).file as string;
    if (!(MEMORY_FILES as readonly string[]).includes(file)) throw new Error('unknown memory file');
    writeMemory(mustProject(id(req)), file, String(body(req).content ?? ''));
    return { ok: true };
  });
  app.get('/api/projects/:id/report', async req => {
    const f = join(plexusDir(mustProject(id(req))), 'REPORT.md');
    return { report: existsSync(f) ? readFileSync(f, 'utf8') : '' };
  });
  app.get('/api/projects/:id/events', async req => recentEvents(id(req), Number((req.query as any).limit ?? 300)));

  // ---- chat
  // Messages of the whole project, or of one chat session (?session=<id>).
  app.get('/api/projects/:id/messages', async req => listMessages(id(req), 300, (req.query as any)?.session || null));
  app.get('/api/projects/:id/chat-sessions', async req => { mustProject(id(req)); return listSessions(id(req), ['1', 'true'].includes(String((req.query as any)?.archived ?? ''))); });
  app.post('/api/projects/:id/chat-sessions', async req => { mustProject(id(req)); return createSession(id(req), String(body(req).title ?? '')); });
  app.patch('/api/chat-sessions/:id', async req => {
    const b = body(req);
    return updateSession(id(req), { ...(b.title !== undefined && { title: String(b.title) }), ...(b.archived !== undefined && { archived: !!b.archived }) });
  });
  app.delete('/api/chat-sessions/:id', async req => {
    const s = mustSession(id(req));
    if (listSessions(s.projectId).filter(x => x.id !== s.id).length === 0) throw new Error('the last chat cannot be deleted; start a new one first');
    deleteSession(s.id);
    return { ok: true };
  });
  app.post('/api/chat-sessions/:id/read', async req => markRead(id(req)));
  // The account/model the coordinator would answer the next message with (what the chat's chip shows).
  app.get('/api/projects/:id/coordinator-target', async req => {
    const t = coordinatorTarget(mustProject(id(req)));
    return { accountId: t.account?.id ?? null, provider: t.account?.provider ?? null, model: t.model ?? null, effort: t.effort ?? null, fallback: !!t.pinnedId && !t.pinned };
  });
  app.post('/api/projects/:id/messages', async (req, reply) => {
    const text = String(body(req).text ?? '').trim();
    mustProject(id(req));
    const sid = body(req).sessionId ? String(body(req).sessionId) : defaultSession(id(req)).id;
    if (mustSession(sid).projectId !== id(req)) throw new Error('chat session belongs to another project');
    const images = saveImages(sid, body(req).images);
    if (!text && !images.length) throw new Error('empty message');
    void handleChat(id(req), text, sid, images).catch(e => bus.emitEvent('orchestrator.error', id(req), { message: `chat: ${e?.message ?? e}` }));
    return reply.code(202).send({ ok: true });
  });
  app.get('/api/messages/:id/images/:imageId', async (req, reply) => {
    const m = getMessage(Number(id(req)));
    const image = (m?.meta?.images as { id: string; mime: string; path: string }[] | undefined)?.find(x => x.id === (req.params as any).imageId);
    if (!image || !existsSync(image.path)) return reply.code(404).send({ error: 'image not found' });
    return reply.type(image.mime).send(readFileSync(image.path));
  });
  app.post('/api/messages/:id/proposal', async req => ({ applied: resolveProposal(Number(id(req)), !!body(req).approve) }));
  // The prompt Plexus sent to the coordinator for this chat message (the last attempt of that turn).
  app.get('/api/messages/:id/prompt', async req => {
    const m = getMessage(Number(id(req)));
    const log = typeof m?.meta?.promptLog === 'string' ? m.meta.promptLog : '';
    return { prompt: readLogTurns(log, 2 * 1024 * 1024)[0]?.prompt ?? '' };
  });

  // ---- tasks
  app.get('/api/tasks/:id', async req => {
    const t = getTask(id(req));
    if (!t) throw new Error('no such task');
    return { task: t, runs: listRuns(t.id) };
  });
  app.get('/api/tasks/:id/log', async req => {
    const runs = listRuns(id(req));
    const runId = Number((req.query as any).run ?? 0);
    const run = runs.find(r => r.id === runId) ?? runs.at(-1);
    if (!run) return { run: null, log: '', prompt: '', events: [] };
    const log = tailFile(run.logPath);
    const events = runEvents(run).slice(-1500);
    return { run, log, prompt: promptOf(run.logPath), events };
  });
  // Every turn sent to the task's agent, run by run: what was asked (messages delivered with it), the size of the
  // prompt (its text comes from /prompt when the user opens it) and what the agent did.
  app.get('/api/tasks/:id/turns', async req => {
    const t = getTask(id(req));
    if (!t) throw new Error('no such task');
    return {
      runs: listRuns(t.id).map(r => ({
        id: r.id, accountId: r.accountId, startedAt: r.startedAt, endedAt: r.endedAt, outcome: r.outcome, usage: r.usage, model: r.model ?? null, effort: r.effort ?? null, timing: r.timing ?? null,
        reason: (r.classification as any)?.reason ?? null,
        turns: readLogTurns(r.logPath).map(x => ({ resuming: x.resuming, at: x.at, promptChars: x.prompt.length,
          kind: /^# STOP: CONTEXT BUDGET SPENT/m.test(x.prompt) ? 'checkpoint' : /^# YOU ARE NOW THE AGENT DOING THE WORK/m.test(x.prompt) ? 'fork' : null, messages: turnMessages(x.prompt), events: streamEvents(r.accountId, x.output).slice(-800) })),
      })),
    };
  });
  app.get('/api/tasks/:id/prompt', async req => {
    const q = req.query as any;
    const run = listRuns(id(req)).find(r => r.id === Number(q.run));
    if (!run) throw new Error('no such run');
    return { prompt: readLogTurns(run.logPath)[Number(q.turn ?? 0)]?.prompt ?? '' };
  });
  app.patch('/api/tasks/:id', async req => {
    const b = body(req);
    const t = getTask(id(req));
    if (!t) throw new Error('no such task');
    // A running attempt keeps the model it started with: the CLI cannot switch it mid-run.
    if (t.status === 'running' && (b.models || b.efforts)) throw new Error('the task is running; change its model or effort when it is not');
    let pin: string | null | undefined;
    if ('pinnedAccountId' in b) {
      pin = b.pinnedAccountId ? String(b.pinnedAccountId) : null;
      if (pin && !listAccounts().some(a => a.id === pin)) throw new Error(`unknown account ${pin}`);
    }
    return updateTask(t.id, { ...(b.priority !== undefined && { priority: Number(b.priority) }), ...(b.description !== undefined && { description: String(b.description) }), ...(b.title !== undefined && { title: String(b.title) }), ...(b.models && typeof b.models === 'object' && { models: cleanModels(b.models) }), ...(b.efforts && typeof b.efforts === 'object' && { efforts: cleanEfforts(b.efforts) }), ...(pin !== undefined && { pinnedAccountId: pin }) });
  });
  app.post('/api/tasks/:id/cancel', async req => { orchestrator.cancelTask(id(req)); return getTask(id(req)); });
  app.post('/api/tasks/:id/retry', async req => { orchestrator.retryTask(id(req)); return getTask(id(req)); });
  app.post('/api/tasks/:id/message', async req => orchestrator.sendMessage(id(req), String(body(req).text ?? '')));
  app.post('/api/tasks/:id/continue', async req => orchestrator.continueTask(id(req), String(body(req).instructions ?? ''), String(body(req).title ?? ''), body(req).sessionId, true));

  // ---- roles
  app.get('/api/roles', async () => listRoles());
  app.put('/api/roles/:name', async req => saveRole({ ...body(req), name: (req.params as any).name }));
  app.delete('/api/roles/:name', async req => { deleteRole((req.params as any).name); return { ok: true }; });
  app.post('/api/roles/:name/reset', async req => resetRole((req.params as any).name));

  // ---- skills
  app.get('/api/skills', async () => listSkills());
  app.post('/api/skills/install', async req => installSkill(String(body(req).source ?? '')));
  app.post('/api/skills/upload', async req => {
    const b = body(req);
    const dir = mkdtempSync(join(tmpdir(), 'plexus-upload-'));
    try {
      const f = join(dir, String(b.filename ?? 'skill.zip').replace(/[^\w.-]/g, '_'));
      writeFileSync(f, Buffer.from(String(b.data ?? ''), 'base64'));
      return installSkill(f);
    } finally { removeTemp(dir); }
  });
  app.post('/api/skills', async req => { const b = body(req); return createSkill(String(b.name), String(b.description ?? ''), String(b.body ?? '')); });
  app.get('/api/skills/:name/files', async req => skillFiles((req.params as any).name));
  app.patch('/api/skills/:name', async req => { setSkillEnabled((req.params as any).name, !!body(req).enabled); return listSkills(); });
  app.delete('/api/skills/:name', async req => { deleteSkill((req.params as any).name); return { ok: true }; });

  // ---- live events
  app.get('/api/ws', { websocket: true }, socket => {
    const send = (ev: unknown) => { try { socket.send(JSON.stringify(ev)); } catch { /* closed */ } };
    bus.on('event', send);
    socket.on('close', () => bus.off('event', send));
  });

  // ---- UI (production build) with the token injected
  const dist = join(appRoot, 'ui', 'dist');
  if (existsSync(join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, index: false, wildcard: false });
    const page = () => readFileSync(join(dist, 'index.html'), 'utf8').replace('<head>', `<head><script>window.PLEXUS_TOKEN=${JSON.stringify(token)}</script>`);
    app.get('/', async (_req, reply) => reply.type('text/html').send(page()));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      const file = join(dist, req.url.split('?')[0]);
      if (existsSync(file) && statSync(file).isFile()) return reply.sendFile(req.url.split('?')[0].slice(1));
      return reply.type('text/html').send(page());
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<p>UI not built. Run <code>npm run ui:build</code> or <code>npm run ui:dev</code>.</p>'));
  }
  return app;
}

export { getAccount };
