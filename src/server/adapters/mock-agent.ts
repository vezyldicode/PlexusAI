// Fake coding agent used by the `mock` provider (tests and demos, no quota spent).
// Speaks the same stream-json protocol as `claude -p --output-format stream-json`, so the
// real Claude classifier is exercised. Behaviour is driven by <home>/mock.json:
//   { "limitAfterRuns": 3, "delayMs": 200, "rejectReviewOnce": true, "compactions": 3 }
// "compactions": the context is compacted that many times in every run (except the checkpoint turn Plexus sends after
// stopping a run for its context budget).
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const home = process.env.MOCK_HOME!;
const cfgPath = join(home, 'mock.json');
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
const statePath = join(home, 'mock-state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { runs: 0 };
state.runs++;
writeFileSync(statePath, JSON.stringify(state));

const prompt = readFileSync(0, 'utf8');
const meta = Object.fromEntries([...prompt.matchAll(/^(role|kind|task_id|result_file):\s*(.+)$/gm)].map(m => [m[1], m[2].trim()]));
// Conversation id like Claude's session_id. `--resume <id>` continues it; ids starting with "dead" are unknown (a purged session).
const resumeIdx = process.argv.indexOf('--resume');
const resumeId = resumeIdx >= 0 ? process.argv[resumeIdx + 1] ?? '' : '';
const sessionId = resumeId || `mock-${Math.random().toString(16).slice(2, 10)}`;
const out = (o: unknown) => process.stdout.write(JSON.stringify({ session_id: sessionId, ...(o as object) }) + '\n');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const resetsAt = Math.floor(Date.now() / 1000) + 3600;

const util = Math.min(1, state.runs * 0.1);
const limited = typeof cfg.limitAfterRuns === 'number' && state.runs > cfg.limitAfterRuns;
if (resumeId.startsWith('dead')) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${resumeId}` });
  process.exit(1);
}
out({ type: 'system', subtype: 'init', model: 'mock' });
out({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: limited ? 'rejected' : 'allowed', rateLimitType: 'five_hour', resetsAt,
    unifiedWindows: {
      five_hour: { utilization: limited ? 1 : util, resetsAt, status: limited ? 'rejected' : 'allowed' },
      seven_day: { utilization: util / 4, resetsAt: resetsAt + 86400, status: 'allowed' },
    },
  },
});
if (limited) {
  const msg = "You've hit your session limit · resets in 1h";
  out({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: msg }] } });
  out({ type: 'result', subtype: 'success', is_error: true, result: msg });
  process.exit(1);
}

const git = (...args: string[]) => { try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e: any) { return String(e.stdout ?? '') + String(e.stderr ?? ''); } };
const say = (text: string) => out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const tool = (name: string, input: unknown) => out({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
/** The checklist, as a real agent reports it (the plexus_plan tool): `at` steps done, the next one in progress. */
const plan = (steps: string[], at: number) => tool('mcp__plexus__plexus_plan', {
  items: steps.map((step, i) => ({ step, status: i < at ? 'completed' : i === at ? 'in_progress' : 'pending' })),
});

const delay = Number(cfg.delayMs ?? 50);
const steps = Number(cfg.steps ?? 3);
for (let i = 0; i < steps; i++) { say(`[mock ${meta.role}] working step ${i + 1}/${steps}`); await sleep(delay); }
const checkpoint = prompt.includes('STOP: CONTEXT BUDGET SPENT');
for (let i = 0; i < Number(cfg.compactions ?? 0) && !checkpoint; i++) {
  tool('Bash', { command: `echo step ${i}` });
  out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 120000, post_tokens: 15000, duration_ms: 1000 } });
  await sleep(delay);
}

let result: any = { status: 'done', summary: `mock ${meta.kind} done` };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';
const mockPlan = () => cfg.planWide
  // Independent tasks for the parallel-scheduling demo; the two alpha tasks touch the same file.
  ? [
      { key: 'a', title: 'Create alpha', description: 'FILE: alpha.txt', role: 'implementer', acceptance: ['alpha.txt exists'], paths: ['alpha.txt'], ac_ids: ['AC1'] },
      { key: 'b', title: 'Create beta', description: 'FILE: beta.txt', role: 'implementer', acceptance: ['beta.txt exists'], paths: ['beta.txt'], ac_ids: ['AC2'] },
      { key: 'g', title: 'Create gamma', description: 'FILE: gamma.txt', role: 'implementer', acceptance: [], paths: ['gamma.txt'] },
      { key: 'a2', title: 'Extend alpha', description: 'FILE: alpha.txt', role: 'implementer', acceptance: [], paths: ['alpha.txt'] },
    ]
  : [
      { key: 'a', title: 'Create alpha', description: 'FILE: alpha.txt', role: 'implementer', acceptance: ['alpha.txt exists'], paths: ['alpha.txt'], ac_ids: ['AC1'] },
      { key: 'b', title: 'Create beta', description: 'FILE: beta.txt', role: 'implementer', depends_on: ['a'], acceptance: ['beta.txt exists'], paths: ['beta.txt'], ac_ids: ['AC2'] },
    ];

/** Call one tool of the MCP server given with --mcp-config (as a real CLI would), returning its text. */
async function mcpCall(tool: string, args: unknown): Promise<string> {
  const i = process.argv.indexOf('--mcp-config');
  if (i < 0) return '(no mcp config)';
  const cfgFile = JSON.parse(readFileSync(process.argv[i + 1], 'utf8'));
  const [name, server] = Object.entries<any>(cfgFile.mcpServers)[0];
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map<number, (v: any) => void>();
  createInterface({ input: child.stdout! }).on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
  let n = 0;
  const rpc = (method: string, params: unknown) => new Promise<any>(res => { const id = ++n; pending.set(id, res); child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mock', version: '0' } });
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc('tools/list', {});
  const r = await rpc('tools/call', { name: tool, arguments: args });
  child.kill();
  return `[${name} tools: ${list.result.tools.length}] ${r.result?.content?.[0]?.text ?? JSON.stringify(r.error)}`;
}

switch (meta.kind) {
  case 'coordinator': {
    const msg = (prompt.match(/USER MESSAGE:\n([\s\S]*?)\n(?:---|$)/)?.[1] ?? '').trim();
    const actions: any[] = [];
    // `action: {...}` lines become actions as they are; `mcp: tool {json args}` calls a plexus tool.
    for (const m of msg.matchAll(/^action:\s*(\{.*\})\s*$/gm)) actions.push(JSON.parse(m[1]));
    const toolCall = msg.match(/^mcp:\s*(\S+)\s*(\{.*\})?\s*$/m);
    const toolOut = toolCall ? await mcpCall(toolCall[1], toolCall[2] ? JSON.parse(toolCall[2]) : {}) : '';
    // `steps`: answer like a coordinator doing a request of several steps (checklist and tool calls stream to the chat).
    if (/\bsteps\b/i.test(msg)) {
      const todo = ['Look at the project status', 'Read the latest task log', 'Answer'];
      plan(todo, 0); tool('mcp__plexus__plexus_status', {}); await sleep(Math.max(delay, 600));
      plan(todo, 1); tool('mcp__plexus__plexus_task_log', { id: 'T1' }); tool('Bash', { command: 'git log --oneline -5' }); await sleep(Math.max(delay, 600));
      plan(todo, 2); await sleep(Math.max(delay, 600)); plan(todo, 3);
    }
    if (/pause|dừng/i.test(msg)) actions.push({ type: 'pause' });
    if (/resume|tiếp tục/i.test(msg)) actions.push({ type: 'resume' });
    const solo = msg.match(/do:\s*(.+)/i);
    if (solo) actions.push({ type: 'solo_task', title: solo[1], description: `FILE: ${slug(solo[1])}.txt` });
    const add = msg.match(/add task:?\s*(.+)/i);
    if (add) actions.push({ type: 'add_task', title: add[1], description: `FILE: ${slug(add[1])}.txt`, role: 'implementer' });
    // A resumed turn carries only what is new; it says so, and which of the new notices it saw, so tests can check the delta.
    const news = prompt.match(/# NEW SINCE YOUR LAST REPLY\n([\s\S]*?)\n\n/)?.[1];
    const reply = `Mock coordinator received: ${msg}${resumeId ? ` [resumed ${resumeId}${news ? `; news: ${news.replace(/\n/g, ' | ')}` : ''}]` : ''}${prompt.includes('# CHAT HISTORY') ? ' [full history]' : ''}${toolOut ? `\nTOOL: ${toolOut}` : ''}`;
    say(JSON.stringify({ reply, actions, proposal: null }));
    out({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ reply, actions, proposal: null }) });
    process.exit(0);
  }
  case 'ingest':
    // `unclearDocs`: the docs are not enough until the user's answer (containing CLARIFIED) is in the goal/directives.
    if (cfg.unclearDocs && !prompt.includes('CLARIFIED')) {
      result.docs_check = { sufficient: false, questions: ['Which files should be created?'] };
      break;
    }
    result.docs_check = { sufficient: true, questions: [] };
    result.execution = { mode: cfg.mode ?? 'team', reason: 'mock' };
    result.project_brief = '# Brief\nMock project: create the files listed in the goal.';
    result.project_summary = 'Mock project: create alpha.txt and beta.txt.';
    result.acceptance_criteria = [{ id: 'AC1', criterion: 'alpha.txt exists', verify: 'ls alpha.txt' }, { id: 'AC2', criterion: 'beta.txt exists', verify: 'ls beta.txt' }];
    result.decisions = [{ title: 'Use plain text files', decision: 'Files are plain text', rationale: 'mock' }];
    break;
  case 'architect':
    writeFileSync('ARCHITECTURE.md', '# Architecture\nMock: one text file per feature.\n');
    git('add', '-A'); git('commit', '-m', 'docs: architecture (mock)');
    // The architect plans in the same session; `architectNoPlan` mimics an older architect role (a planner runs after it).
    if (!cfg.architectNoPlan) result.tasks = mockPlan();
    break;
  case 'plan':
    result.tasks = mockPlan();
    break;
  case 'solo': {
    // One agent does everything: the files named in the task (FILE: x), else the mock project's files.
    // `soloFirstFiles`: what the first round writes; `soloNoProgress`: later rounds change nothing (a stalled agent).
    const gapRound = /# TASK T\d+: Close the remaining gaps/.test(prompt);
    const named = [...new Set([...prompt.matchAll(/FILE:\s*(\S+)/g)].map(m => m[1]))];
    const files = gapRound && cfg.soloNoProgress ? [] : !gapRound && cfg.soloFirstFiles ? cfg.soloFirstFiles : named.length ? named : ['alpha.txt', 'beta.txt'];
    const todo = ['Read the task and the code map', ...files.map(f => `Write ${f}`), 'Commit and evaluate'];
    plan(todo, 0);
    tool('Read', { file_path: '.plexus-task/contract.md' });
    tool('Grep', { pattern: 'FILE:' });
    say(`Writing ${files.join(', ') || 'nothing new'}.`);
    for (const [i, f] of files.entries()) {
      plan(todo, i + 1);
      tool('Write', { file_path: f });
      writeFileSync(f, (existsSync(f) ? readFileSync(f, 'utf8') : '') + `written by mock (solo, ${meta.task_id})\n`);
    }
    plan(todo, files.length + 1);
    tool('Bash', { command: 'git status --short' });
    if (files.length) { git('add', '-A'); git('commit', '-m', `solo: ${files.join(', ')} (mock)`); }
    plan(todo, todo.length);
    if (cfg.soloEscalate && !existsSync(join(home, 'escalated'))) {
      writeFileSync(join(home, 'escalated'), '1');
      result.escalate = { reason: 'mock: the rest needs a team' };
      break;
    }
    const missing = ['alpha.txt', 'beta.txt', ...(cfg.extraFiles ?? [])].filter(f => !existsSync(f));
    result.evaluation = {
      complete: missing.length === 0,
      criteria: [{ id: 'AC1', pass: existsSync('alpha.txt'), evidence: 'ls' }, { id: 'AC2', pass: existsSync('beta.txt'), evidence: 'ls' }],
      report: `# Report\nMock solo build. Missing: ${missing.join(', ') || 'none'}`,
    };
    if (missing.length) result.follow_up_tasks = missing.map(f => ({ title: `Create ${f}`, description: `FILE: ${f}`, role: 'implementer' }));
    break;
  }
  case 'review': {
    const rejectedFile = join(home, `rejected-${meta.task_id}`);
    if (cfg.rejectReviewOnce && !existsSync(rejectedFile) && !/review_cycle: [1-9]/.test(prompt)) {
      writeFileSync(rejectedFile, '1');
      result.review = { verdict: 'changes_requested', comments: ['Add a trailing newline (mock)'] };
    } else result.review = { verdict: 'approve', comments: [] };
    break;
  }
  case 'evaluate': {
    const missing = ['alpha.txt', 'beta.txt', ...(cfg.extraFiles ?? [])].filter(f => !existsSync(f));
    result.evaluation = {
      complete: missing.length === 0,
      criteria: [{ id: 'AC1', pass: existsSync('alpha.txt'), evidence: 'ls' }, { id: 'AC2', pass: existsSync('beta.txt'), evidence: 'ls' }],
      report: `# Report\nMock evaluation. Missing: ${missing.join(', ') || 'none'}`,
    };
    if (missing.length) result.follow_up_tasks = missing.map(f => ({ title: `Create ${f}`, description: `FILE: ${f}`, role: 'implementer' }));
    break;
  }
  case 'compact': {
    // Librarian: one entry per distinct title of the snapshot it was given.
    const snapFile = '.plexus-task/context/decisions.md';
    const snap = existsSync(snapFile) ? readFileSync(snapFile, 'utf8') : '';
    const titles = [...new Set([...snap.matchAll(/^## (.+)$/gm)].map(m => m[1].trim()))];
    result.decisions_digest = titles.map(title => ({ title, decision: `digest of ${title}`, rationale: '' }));
    break;
  }
  case 'qa':
    break;
  default: { // build, fix, integrate, custom
    // `blockKinds`: these kinds answer "blocked" until a message for them arrives (delivered in the prompt).
    if ((cfg.blockKinds ?? []).includes(meta.kind) && !/## Messages for you/.test(prompt)) {
      result = { status: 'blocked', summary: 'mock: need to know which file to write', questions: [{ question: 'Which file?', default_answer: '' }] };
      break;
    }
    const file = prompt.match(/FILE:\s*(\S+)/)?.[1] ?? `${slug(meta.task_id ?? 'out')}.txt`;
    const todo = ['Read the task contract', `Write ${file}`, 'Check the result', 'Commit and write the result file'];
    plan(todo, 0);
    tool('Read', { file_path: '.plexus-task/contract.md' });
    tool('Bash', { command: 'git status --short' });
    await sleep(delay);
    plan(todo, 1);
    say(`Writing ${file}.`);
    tool('Write', { file_path: file });
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(file, prev + `written by mock (${meta.kind}, ${meta.task_id})\n`);
    if (cfg.crashMidTask && !existsSync(join(home, `crashed-${meta.task_id}`))) {
      writeFileSync(join(home, `crashed-${meta.task_id}`), '1');
      say('mock: crashing mid-task'); process.exit(3);
    }
    plan(todo, 2);
    tool('Bash', { command: `cat ${file}` });
    await sleep(delay);
    plan(todo, 3);
    git('add', '-A'); git('commit', '-m', `${meta.kind}: ${file} (mock)`);
    plan(todo, todo.length);
  }
}

if (checkpoint) result = { ...result, status: 'partial', summary: `checkpoint after context budget: ${result.summary}`, follow_up_tasks: [{ title: 'Rest of the work', description: 'what is left', role: 'implementer', acceptance: [], paths: [] }] };
if (meta.result_file) {
  mkdirSync(dirname(meta.result_file), { recursive: true });
  writeFileSync(meta.result_file, JSON.stringify(result, null, 2));
}
say(`Done. Result written to ${meta.result_file}`);
out({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 10, output_tokens: 5 } });
