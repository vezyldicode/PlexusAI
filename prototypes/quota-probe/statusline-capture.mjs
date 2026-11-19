// Claude Code statusLine hook: saves the rate_limits snapshot Claude Code pipes in on stdin
// to <CLAUDE_CONFIG_DIR>/swarm-ratelimits.json (read by probe.mjs), and prints a short status line.
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  appendFileSync(join(home, 'swarm-statusline-calls.log'), new Date().toISOString() + ' ' + raw.slice(0, 4000) + '\n');
  if (input.rate_limits) {
    writeFileSync(join(home, 'swarm-ratelimits.json'), JSON.stringify({ capturedAt: new Date().toISOString(), ...input.rate_limits }, null, 1));
  }
  const fh = input.rate_limits?.five_hour?.used_percentage;
  const wk = input.rate_limits?.seven_day?.used_percentage;
  process.stdout.write(`5h ${fh ?? '?'}% · week ${wk ?? '?'}%`);
});
