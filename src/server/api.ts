import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdtempSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { Provider } from '../shared/types.ts';
import { addAccount, getAccount, listAccounts, openLogin, probeAccount, removeAccount, updateAccount } from './accounts.ts';
import { createSession, defaultSession, deleteSession, listSessions, markRead, mustSession, updateSession } from './chat.ts';
import { applyActions, handleChat, resolveProposal } from './coordinator.ts';
import { bus, recentEvents } from './events.ts';
import { orchestrator } from './orchestrator.ts';
import { appRoot } from './paths.ts';
import {
  createProject, deleteProject, getProject, listMessages, listProjects, MEMORY_FILES, mustProject, readAcceptance, readMemory, plexusDir,
  updateProject, writeMemory,
} from './projects.ts';
import { deleteRole, listRoles, resetRole, saveRole } from './roles.ts';
import { createSkill, deleteSkill, installSkill, listSkills, removeTemp, setSkillEnabled, skillFiles } from './skills.ts';
import { countByStatus, getTask, listRuns, listTasks, updateTask } from './tasks.ts';
import { describeClaudeEvent } from './adapters/claude.ts';
import { describeCodexEvent } from './adapters/codex.ts';
import { cleanEfforts, modelCatalog } from './models.ts';

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

export async function buildApi(token: string, hooks: { shutdown: () => Promise<void> } = { shutdown: async () => {} }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
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
  // Models and efforts offered by the enabled accounts' CLIs (cached 12 h; ?refresh=1 re-reads them).
  app.get('/api/models', async req => modelCatalog(listAccounts(), ['1', 'true'].includes(String((req.query as any)?.refresh ?? ''))));

  // ---- projects
  app.get('/api/projects', async () => listProjects().map(p => ({ ...p, counts: countByStatus(p.id) })));
  app.post('/api/projects', async req => {
    const b = body(req);
    if (!b.path) throw new Error('path is required');
    const p = createProject({ path: b.path, name: b.name, goal: b.goal, settings: b.settings });
    if (b.start) await orchestrator.startProject(p.id, b.sessionId);
    return getProject(p.id);
  });
  app.get('/api/projects/:id', async req => {
    const p = mustProject(id(req));
    return { project: p, tasks: listTasks(p.id), counts: countByStatus(p.id), acceptance: readAcceptance(p), waiting: orchestrator.waiting.get(p.id) ?? null };
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
  app.delete('/api/projects/:id', async req => { orchestrator.stop(id(req)); deleteProject(id(req)); return { ok: true }; });
  app.post('/api/projects/:id/start', async req => orchestrator.startProject(id(req), body(req).sessionId));
  app.post('/api/projects/:id/pause', async req => { orchestrator.pause(id(req), body(req).sessionId); return mustProject(id(req)); });
  app.post('/api/projects/:id/resume', async req => { await orchestrator.resume(id(req), body(req).sessionId); return mustProject(id(req)); });
  app.post('/api/projects/:id/stop', async req => { orchestrator.stop(id(req), body(req).sessionId); return mustProject(id(req)); });
  app.post('/api/projects/:id/actions', async req => ({ applied: applyActions(id(req), body(req).actions ?? [], 'user', body(req).sessionId) }));
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
  app.post('/api/projects/:id/messages', async (req, reply) => {
    const text = String(body(req).text ?? '').trim();
    if (!text) throw new Error('empty message');
    mustProject(id(req));
    const sid = body(req).sessionId ? String(body(req).sessionId) : defaultSession(id(req)).id;
    if (mustSession(sid).projectId !== id(req)) throw new Error('chat session belongs to another project');
    void handleChat(id(req), text, sid).catch(e => bus.emitEvent('orchestrator.error', id(req), { message: `chat: ${e?.message ?? e}` }));
    return reply.code(202).send({ ok: true });
  });
  app.post('/api/messages/:id/proposal', async req => ({ applied: resolveProposal(Number(id(req)), !!body(req).approve) }));

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
    const provider = getAccount(run.accountId)?.provider ?? (run.accountId.startsWith('codex') ? 'codex' : 'claude');
    const describe = provider === 'codex' ? describeCodexEvent : describeClaudeEvent;
    const marker = log.indexOf('\n# output\n');
    const out = marker < 0 ? log : log.slice(marker + '\n# output\n'.length);
    const events = out.split('\n').filter(Boolean).map(l => describe(l)).filter((e): e is NonNullable<typeof e> => !!e && e.kind !== 'raw').slice(-1500);
    return { run, log, prompt: promptOf(run.logPath), events };
  });
  app.patch('/api/tasks/:id', async req => {
    const b = body(req);
    return updateTask(id(req), { ...(b.priority !== undefined && { priority: Number(b.priority) }), ...(b.description !== undefined && { description: String(b.description) }), ...(b.title !== undefined && { title: String(b.title) }), ...(b.models && typeof b.models === 'object' && { models: cleanModels(b.models) }), ...(b.efforts && typeof b.efforts === 'object' && { efforts: cleanEfforts(b.efforts) }) });
  });
  app.post('/api/tasks/:id/cancel', async req => { orchestrator.cancelTask(id(req)); return getTask(id(req)); });
  app.post('/api/tasks/:id/retry', async req => { orchestrator.retryTask(id(req)); return getTask(id(req)); });

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
