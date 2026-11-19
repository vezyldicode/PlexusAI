// Quota probe prototype — reads per-account quota for Codex and Claude Code accounts.
//
// Usage:  node probe.mjs accounts.json [--interval 60] [--once]
//
// accounts.json:
//   [ { "id": "codex-01",  "provider": "codex",  "home": "C:/Users/me/.codex" },
//     { "id": "claude-01", "provider": "claude", "home": "C:/Users/me/.claude" } ]
//
// Codex : live % of 5h / weekly window via `codex app-server` (JSON-RPC over stdio,
//         method account/rateLimits/read) + push notifications account/rateLimits/updated.
//         One long-lived app-server process per account, isolated by CODEX_HOME.
// Claude: (a) live % of 5h / weekly window from the `rate_limit_event` that `claude -p
//         --output-format stream-json --verbose` emits (verified CLI 2.1.327; field
//         rate_limit_info.unifiedWindows.{five_hour,seven_day}.utilization, 0..1). With
//         --claude-probe an idle account is probed with one tiny Haiku call (~5 s).
//         (b) token usage from local session logs <home>/projects/**/*.jsonl (no network).
//         Accounts are isolated by CLAUDE_CONFIG_DIR. The statusLine hook is NOT called in -p mode.

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifyClaudeRun, claudeRateLimitSnapshot } from './claude-limits.mjs';

const args = process.argv.slice(2);
const accounts = JSON.parse(readFileSync(args[0] ?? 'accounts.json', 'utf8'));
const interval = Number(args[args.indexOf('--interval') + 1]) || 60;
const once = args.includes('--once');
const state = new Map(); // id -> snapshot

// ---------- Codex ----------
class CodexClient {
  constructor(acct) {
    this.acct = acct; this.nextId = 0; this.pending = new Map(); this.buf = '';
    this.proc = spawn('codex app-server', {
      shell: true, env: { ...process.env, CODEX_HOME: acct.home }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.proc.stdout.on('data', d => this.#onData(d));
  }
  #onData(d) {
    this.buf += d; let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
      else if (msg.method === 'account/rateLimits/updated') update(this.acct, codexSnapshot(msg.params?.rateLimits ?? msg.params), 'push');
    }
  }
  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, 20000);
      this.pending.set(id, m => { clearTimeout(t); resolve(m); });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async init() {
    await this.request('initialize', { clientInfo: { name: 'plexus-quota-probe', version: '0.0.1' } });
    this.proc.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }
  async poll() {
    const m = await this.request('account/rateLimits/read', { excludeResetCreditDetails: true });
    if (m.error) update(this.acct, { status: /auth/i.test(m.error.message) ? 'needs_login' : 'error', error: m.error.message }, 'poll');
    else update(this.acct, codexSnapshot(m.result.rateLimits), 'poll');
  }
  close() { this.proc.kill(); }
}

function codexSnapshot(rl) {
  if (!rl) return { status: 'unknown' };
  const win = w => w && { usedPercent: w.usedPercent, windowMins: w.windowDurationMins, resetsAt: w.resetsAt && new Date(w.resetsAt * 1000).toISOString() };
  return {
    status: rl.rateLimitReachedType ? 'limited' : 'ok',
    plan: rl.planType,
    primary: win(rl.primary),
    secondary: win(rl.secondary),
  };
}

// ---------- Claude ----------
function* walkJsonl(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

function claudeSnapshot(acct) {
  const since = Date.now() - 5 * 3600 * 1000;
  const tok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
  for (const f of walkJsonl(join(acct.home, 'projects'))) {
    if (statSync(f).mtimeMs < since) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const u = o.message?.usage; const ts = Date.parse(o.timestamp);
      if (!u || !(ts >= since)) continue;
      tok.input += u.input_tokens ?? 0; tok.output += u.output_tokens ?? 0;
      tok.cacheRead += u.cache_read_input_tokens ?? 0; tok.cacheWrite += u.cache_creation_input_tokens ?? 0;
      tok.messages++;
    }
  }
  const snapFile = join(acct.home, 'plexus-ratelimits.json');
  const rateLimits = existsSync(snapFile) ? JSON.parse(readFileSync(snapFile, 'utf8')) : null;
  return { status: rateLimits ? 'ok' : 'tokens_only', tokensLast5h: tok, rateLimits };
}

// Live probe for an idle Claude account: one minimal Haiku call (~5 s, tiny quota cost).
// Only when --claude-probe is passed; Plexus should do this rarely (e.g. stale > 10 min).
function claudeProbe(acct) {
  return new Promise(resolve => {
    const p = spawn('claude -p ok --model haiku --output-format stream-json --verbose --max-turns 1 --tools ""', {
      shell: true, cwd: acct.home, env: { ...process.env, CLAUDE_CONFIG_DIR: acct.home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '', err = '';
    p.stdout.on('data', d => { buf += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve(claudeRateLimitSnapshot(classifyClaudeRun({ stdout: buf, stderr: err, exitCode: code ?? 0 }))));
  });
}

// ---------- main ----------
function update(acct, snap, source) {
  state.set(acct.id, { provider: acct.provider, source, at: new Date().toISOString(), ...snap });
}

function render() {
  console.log('\n=== quota @', new Date().toLocaleTimeString());
  for (const [id, s] of state) console.log(id, JSON.stringify(s));
}

const codex = [];
for (const a of accounts.filter(a => a.provider === 'codex')) {
  const c = new CodexClient(a);
  try { await c.init(); codex.push(c); } catch (e) { update(a, { status: 'error', error: e.message }, 'init'); }
}

async function tick() {
  await Promise.all(codex.map(c => c.poll().catch(e => update(c.acct, { status: 'error', error: e.message }, 'poll'))));
  for (const a of accounts.filter(a => a.provider === 'claude')) {
    const local = claudeSnapshot(a);
    if (args.includes('--claude-probe')) update(a, { ...(await claudeProbe(a)), tokensLast5h: local.tokensLast5h }, 'live-probe');
    else update(a, local, 'local-logs');
  }
  render();
}

await tick();
if (once) { codex.forEach(c => c.close()); process.exit(0); }
setInterval(tick, interval * 1000);
