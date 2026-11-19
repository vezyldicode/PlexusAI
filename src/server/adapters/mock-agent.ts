// Fake coding agent used by the `mock` provider (tests and demos, no quota spent).
// Speaks the same stream-json protocol as `claude -p --output-format stream-json`, so the
// real Claude classifier is exercised. Behaviour is driven by <home>/mock.json:
//   { "limitAfterRuns": 3, "delayMs": 200, "rejectReviewOnce": true }
import { execFileSync } from 'node:child_process';
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

const delay = Number(cfg.delayMs ?? 50);
const steps = Number(cfg.steps ?? 3);
for (let i = 0; i < steps; i++) { say(`[mock ${meta.role}] working step ${i + 1}/${steps}`); await sleep(delay); }

let result: any = { status: 'done', summary: `mock ${meta.kind} done` };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';

switch (meta.kind) {
  case 'coordinator': {
    const msg = (prompt.match(/USER MESSAGE:\n([\s\S]*?)\n(?:---|$)/)?.[1] ?? '').trim();
    const actions: any[] = [];
    if (/pause|dừng/i.test(msg)) actions.push({ type: 'pause' });
    if (/resume|tiếp tục/i.test(msg)) actions.push({ type: 'resume' });
    const add = msg.match(/add task:?\s*(.+)/i);
    if (add) actions.push({ type: 'add_task', title: add[1], description: `FILE: ${slug(add[1])}.txt`, role: 'implementer' });
    // A resumed turn carries only what is new; it says so, and which of the new notices it saw, so tests can check the delta.
    const news = prompt.match(/# NEW SINCE YOUR LAST REPLY\n([\s\S]*?)\n\n/)?.[1];
    const reply = `Mock coordinator received: ${msg}${resumeId ? ` [resumed ${resumeId}${news ? `; news: ${news.replace(/\n/g, ' | ')}` : ''}]` : ''}${prompt.includes('# CHAT HISTORY') ? ' [full history]' : ''}`;
    say(JSON.stringify({ reply, actions, proposal: null }));
    out({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ reply, actions, proposal: null }) });
    process.exit(0);
  }
  case 'ingest':
    result.project_brief = '# Brief\nMock project: create the files listed in the goal.';
    result.acceptance_criteria = [{ id: 'AC1', criterion: 'alpha.txt exists', verify: 'ls alpha.txt' }, { id: 'AC2', criterion: 'beta.txt exists', verify: 'ls beta.txt' }];
    result.decisions = [{ title: 'Use plain text files', decision: 'Files are plain text', rationale: 'mock' }];
    break;
  case 'architect':
    writeFileSync('ARCHITECTURE.md', '# Architecture\nMock: one text file per feature.\n');
    git('add', '-A'); git('commit', '-m', 'docs: architecture (mock)');
    break;
  case 'plan':
    result.tasks = cfg.planWide
      // Independent tasks for the parallel-scheduling demo; the two alpha tasks touch the same file.
      ? [
          { key: 'a', title: 'Create alpha', description: 'FILE: alpha.txt', role: 'implementer', acceptance: ['alpha.txt exists'], paths: ['alpha.txt'] },
          { key: 'b', title: 'Create beta', description: 'FILE: beta.txt', role: 'implementer', acceptance: ['beta.txt exists'], paths: ['beta.txt'] },
          { key: 'g', title: 'Create gamma', description: 'FILE: gamma.txt', role: 'implementer', acceptance: [], paths: ['gamma.txt'] },
          { key: 'a2', title: 'Extend alpha', description: 'FILE: alpha.txt', role: 'implementer', acceptance: [], paths: ['alpha.txt'] },
        ]
      : [
          { key: 'a', title: 'Create alpha', description: 'FILE: alpha.txt', role: 'implementer', acceptance: ['alpha.txt exists'], paths: ['alpha.txt'] },
          { key: 'b', title: 'Create beta', description: 'FILE: beta.txt', role: 'implementer', depends_on: ['a'], acceptance: ['beta.txt exists'], paths: ['beta.txt'] },
        ];
    break;
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
  case 'qa':
    break;
  default: { // build, fix, integrate, custom
    const file = prompt.match(/FILE:\s*(\S+)/)?.[1] ?? `${slug(meta.task_id ?? 'out')}.txt`;
    tool('Write', { file_path: file });
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(file, prev + `written by mock (${meta.kind}, ${meta.task_id})\n`);
    if (cfg.crashMidTask && !existsSync(join(home, `crashed-${meta.task_id}`))) {
      writeFileSync(join(home, `crashed-${meta.task_id}`), '1');
      say('mock: crashing mid-task'); process.exit(3);
    }
    git('add', '-A'); git('commit', '-m', `${meta.kind}: ${file} (mock)`);
  }
}

if (meta.result_file) {
  mkdirSync(dirname(meta.result_file), { recursive: true });
  writeFileSync(meta.result_file, JSON.stringify(result, null, 2));
}
say(`Done. Result written to ${meta.result_file}`);
out({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 10, output_tokens: 5 } });
