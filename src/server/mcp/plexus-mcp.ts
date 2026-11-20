// The coordinator's `plexus` tools: a minimal MCP server (JSON-RPC 2.0, one message per line on stdio) that the
// coordinator's CLI starts (claude --mcp-config / codex -c mcp_servers.plexus...). Each tool calls the daemon's API.
// Environment: PLEXUS_API (http://127.0.0.1:<port>), PLEXUS_TOKEN, PLEXUS_PROJECT, PLEXUS_SESSION.
import { createInterface } from 'node:readline';

const API = process.env.PLEXUS_API ?? '';
const TOKEN = process.env.PLEXUS_TOKEN ?? '';
const PROJECT = process.env.PLEXUS_PROJECT ?? '';
const SESSION = process.env.PLEXUS_SESSION ?? '';

interface Tool { name: string; description: string; inputSchema: Record<string, unknown>; call: (a: any) => Promise<string> }

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${API}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-plexus-token': TOKEN }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j;
}

const obj = (props: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });
const P = encodeURIComponent(PROJECT);

const tools: Tool[] = [
  {
    name: 'plexus_status', description: 'Project status: phase, tasks (status, account, paths, errors), accounts and quota, recent events.',
    inputSchema: obj(), call: async () => (await api('GET', `/api/projects/${P}/status-digest`)).text,
  },
  {
    name: 'plexus_task', description: 'One task: description, result (summary, evaluation, issues), error, runs with tokens and log paths, worktree, branch, lane.',
    inputSchema: obj({ id: str('task id, e.g. T5') }, ['id']),
    call: async a => JSON.stringify(await api('GET', `/api/projects/${P}/tasks/${encodeURIComponent(a.id)}`), null, 2),
  },
  {
    name: 'plexus_task_log', description: 'What the agent of a task did (its messages, tool calls, status lines), newest last. Use grep to filter.',
    inputSchema: obj({ id: str('task id, e.g. T5'), tail: { type: 'number', description: 'last N lines (default 120)' }, grep: str('only lines containing this text (case-insensitive)'), run: { type: 'number', description: 'run id (default: the last run)' } }, ['id']),
    call: async a => {
      const q = new URLSearchParams({ tail: String(a.tail ?? 120), ...(a.grep ? { grep: a.grep } : {}), ...(a.run ? { run: String(a.run) } : {}) });
      const j = await api('GET', `/api/projects/${P}/tasks/${encodeURIComponent(a.id)}/events?${q}`);
      return `${j.header}\n${j.lines.join('\n') || '(no lines)'}`;
    },
  },
  {
    name: 'plexus_action', description: 'Apply one Plexus action, the same JSON as the OUTPUT action list (solo_task, continue_task, send_message, assign_account, cancel_task, retry_task, add_directive, remove_directive, record_decision, set_goal, pause, resume, stop, add_task, replan, update_task, reprioritize).',
    inputSchema: obj({ action: { type: 'object', description: 'e.g. {"type":"continue_task","task_id":"T5","instructions":"..."}' } }, ['action']),
    call: async a => (await api('POST', `/api/projects/${P}/actions`, { actions: [a.action], sessionId: SESSION })).applied.join('\n'),
  },
  {
    name: 'plexus_main_begin', description: 'Before editing files in the main checkout: holds merges back until plexus_main_commit (10 minutes at most).',
    inputSchema: obj(), call: async () => (await api('POST', `/api/projects/${P}/main/begin`, {})).text,
  },
  {
    name: 'plexus_main_commit', description: 'Finish your edits in the main checkout and let merges continue. The edits stay uncommitted for the user to review (Plexus commits them only when auto-commit is on in Settings).',
    inputSchema: obj({ message: str('what you changed (used as the commit message only with auto-commit on)') }, ['message']),
    call: async a => (await api('POST', `/api/projects/${P}/main/commit`, { message: a.message })).text,
  },
  {
    name: 'plexus_workspace', description: 'Your own git worktree (internal branch plexus/coordinator) for larger changes; returns its path.',
    inputSchema: obj(), call: async () => (await api('POST', `/api/projects/${P}/coordinator-workspace`, {})).text,
  },
  {
    name: 'plexus_workspace_merge', description: 'Merge your worktree through the merge queue; the result reaches the project folder as uncommitted changes (committed on the branch only with auto-commit on).',
    inputSchema: obj({ message: str('what the change does') }, ['message']),
    call: async a => (await api('POST', `/api/projects/${P}/coordinator-workspace/merge`, { message: a.message })).text,
  },
];

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(m: any) {
  const { id, method, params } = m ?? {};
  if (id === undefined || id === null) return; // notifications (initialized, cancelled)
  switch (method) {
    case 'initialize':
      return reply(id, { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'plexus', version: '1.0.0' } });
    case 'ping': return reply(id, {});
    case 'tools/list': return reply(id, { tools: tools.map(({ call: _c, ...t }) => t) });
    case 'tools/call': {
      const t = tools.find(x => x.name === params?.name);
      if (!t) return fail(id, -32602, `unknown tool ${params?.name}`);
      try { return reply(id, { content: [{ type: 'text', text: await t.call(params?.arguments ?? {}) }] }); }
      catch (e: any) { return reply(id, { content: [{ type: 'text', text: `Error: ${e?.message ?? e}` }], isError: true }); }
    }
    default: return fail(id, -32601, `method not found: ${method}`);
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let m: any;
  try { m = JSON.parse(line); } catch { return fail(null, -32700, 'parse error'); }
  void handle(m);
});
