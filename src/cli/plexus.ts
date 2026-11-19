#!/usr/bin/env node
// Thin CLI over the daemon's HTTP API.  Usage: node src/cli/plexus.ts <command> ...
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths } from '../server/paths.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flags: Record<string, string | boolean> = {};
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = rest[i + 1]; if (v && !v.startsWith('--')) { flags[k] = v; i++; } else flags[k] = true; }
  else args.push(a);
}

const base = `http://127.0.0.1:${process.env.PLEXUS_PORT ?? 4317}`;
const token = existsSync(paths.token) ? readFileSync(paths.token, 'utf8').trim() : '';

async function api(method: string, path: string, body?: unknown): Promise<any> {
  let r: Response;
  try {
    r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-plexus-token': token }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    console.error(`Daemon not reachable at ${base}. Start it with: npm run daemon`);
    process.exit(2);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`Error ${r.status}: ${j.error ?? JSON.stringify(j)}`); process.exit(1); }
  return j;
}

const pct = (w: any) => (w?.usedPercent ?? null) === null ? '  -' : String(w.usedPercent).padStart(3) + '%';

const help = `plexus — autonomous multi-agent development system

  plexus daemon                                   start the daemon (foreground)
  plexus shutdown                                 stop the running daemon (agents resume on next start)
  plexus accounts                                 list accounts with quota
  plexus account add <claude|codex|mock> [--id x] [--label "..."] [--home dir] [--max 1]
  plexus account login <id>                       open a terminal to log this account in
  plexus account probe <id>                       refresh state/quota now
  plexus account enable|disable|remove <id>
  plexus projects                                 list projects
  plexus project add <path> [--name n] [--goal "..."] [--start]
  plexus start|pause|resume|stop <project>
  plexus tasks <project>                          task list
  plexus log <task-id>                            log of the latest run
  plexus chat <project> "message"                 talk to the coordinator
  plexus watch <project>                          follow the chat and events`;

switch (cmd) {
  case 'daemon': {
    const { startDaemon } = await import('../server/main.ts');
    const d = await startDaemon();
    const stop = async () => { await d.shutdown(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    break;
  }
  case 'shutdown': {
    await api('POST', '/api/shutdown');
    console.log('Daemon is shutting down.');
    break;
  }
  case 'accounts': {
    const list = await api('GET', '/api/accounts');
    if (!list.length) console.log('No accounts. Add one: plexus account add claude');
    for (const a of list) console.log(`${a.id.padEnd(14)} ${a.provider.padEnd(7)} ${(a.enabled ? a.state : 'disabled').padEnd(12)} 5h ${pct(a.quota?.primary)}  week ${pct(a.quota?.secondary)}  running ${a.running}${a.cooldownUntil ? `  until ${a.cooldownUntil}` : ''}`);
    break;
  }
  case 'account': {
    const [sub, x] = args;
    if (sub === 'add') {
      const a = await api('POST', '/api/accounts', { provider: x, id: flags.id, label: flags.label, home: flags.home ? resolve(String(flags.home)) : undefined, maxConcurrency: flags.max ? Number(flags.max) : undefined });
      console.log(`Added ${a.id} (home ${a.home}).${a.provider !== 'mock' ? ` Log in with: plexus account login ${a.id}` : ''}`);
    } else if (sub === 'login') { const r = await api('POST', `/api/accounts/${x}/login`); console.log(r.opened ? 'A login window was opened.' : `Run this in a terminal:\n${r.command}`); }
    else if (sub === 'probe') { const a = await api('POST', `/api/accounts/${x}/probe`); console.log(`${a.id}: ${a.state} 5h ${pct(a.quota?.primary)} week ${pct(a.quota?.secondary)}`); }
    else if (sub === 'enable' || sub === 'disable') { await api('PATCH', `/api/accounts/${x}`, { enabled: sub === 'enable' }); console.log('ok'); }
    else if (sub === 'remove') { await api('DELETE', `/api/accounts/${x}`); console.log('removed (home folder kept)'); }
    else console.log(help);
    break;
  }
  case 'projects': {
    for (const p of await api('GET', '/api/projects')) console.log(`${p.id.padEnd(26)} ${p.status.padEnd(10)} ${p.phase.padEnd(12)} ${JSON.stringify(p.counts)}  ${p.path}`);
    break;
  }
  case 'project': {
    if (args[0] !== 'add' || !args[1]) { console.log(help); break; }
    const p = await api('POST', '/api/projects', { path: resolve(args[1]), name: flags.name, goal: flags.goal, start: !!flags.start });
    console.log(`Project ${p.id} (${p.status}).${flags.start ? '' : ` Start with: plexus start ${p.id}`}`);
    break;
  }
  case 'start': case 'pause': case 'resume': case 'stop': {
    const p = await api('POST', `/api/projects/${args[0]}/${cmd}`);
    console.log(`${p.id}: ${p.status} (phase ${p.phase})`);
    break;
  }
  case 'tasks': {
    const d = await api('GET', `/api/projects/${args[0]}`);
    console.log(`${d.project.name}: ${d.project.status} / ${d.project.phase}`);
    for (const t of d.tasks) console.log(`T${String(t.seq).padEnd(4)} ${t.status.padEnd(11)} ${t.role.padEnd(12)} ${(t.accountId ?? '').padEnd(12)} ${t.title}${t.error ? `  [${t.error.slice(0, 80)}]` : ''}`);
    break;
  }
  case 'log': {
    const d = await api('GET', `/api/tasks/${args[0]}/log`);
    console.log(d.log || '(no runs yet)');
    break;
  }
  case 'chat': {
    const [pid, ...words] = args;
    const before = (await api('GET', `/api/projects/${pid}/messages`)).length;
    await api('POST', `/api/projects/${pid}/messages`, { text: words.join(' ') });
    process.stdout.write('waiting for the coordinator');
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const msgs = await api('GET', `/api/projects/${pid}/messages`);
      const reply = msgs.slice(before).find((m: any) => m.author === 'coordinator' || (m.author === 'system' && m.meta?.level === 'attention'));
      if (reply) { console.log(`\n\n${reply.text}`); if (reply.meta?.applied?.length) console.log(`\nApplied: ${reply.meta.applied.join('; ')}`); if (reply.meta?.proposal) console.log(`\nProposal (approve in the UI): ${reply.meta.proposal.summary}`); break; }
      process.stdout.write('.');
    }
    break;
  }
  case 'watch': {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ws?token=${token}`);
    ws.onmessage = ev => {
      const e = JSON.parse(String(ev.data));
      if (e.projectId !== args[0]) return;
      if (e.type === 'task.log') console.log(`  T${e.data.seq} ${e.data.account} ${e.data.kind}: ${String(e.data.text).split('\n')[0].slice(0, 160)}`);
      else if (e.type === 'chat.message') console.log(`[${e.data.author}] ${e.data.text}`);
      else console.log(`* ${e.type} ${JSON.stringify(e.data).slice(0, 200)}`);
    };
    break;
  }
  default:
    console.log(help);
}
