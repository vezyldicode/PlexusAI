// Boot screen (every launch) and first-run setup (once). The Plexus mark is the visual of both: on boot it beats
// itself once; during setup each outer node is one requirement (Git, a coding CLI, a signed-in account) and lights
// up when it is ready, with its vessel to the core. The core lights when all three are.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, Copy, ExternalLink, RotateCw, SquareTerminal } from 'lucide-react';
import { api } from './api.ts';
import type { Account, Provider } from './types.ts';
import { Ic } from './ui.tsx';

// ---------------------------------------------------------------- the mark

/** Same geometry as public/plexus.svg, scaled by 10. */
const CORE = { x: 80, y: 80, r: 20 };
const SATS = {
  git: { x: 25, y: 35, r: 12.5, edge: 'M35 43 64 70', label: 'Git', lx: 25, ly: 10 },
  cli: { x: 135, y: 40, r: 12.5, edge: 'M124 47 96 70', label: 'CLI', lx: 135, ly: 15 },
  account: { x: 120, y: 130, r: 12.5, edge: 'M112 121 94 94', label: 'Account', lx: 120, ly: 162 },
} as const;
type Sat = keyof typeof SATS;
export type Lit = Partial<Record<Sat | 'core', boolean>>;

/**
 * `lit` given: setup mode (outer nodes dim until ready, labelled). Otherwise the brand mark in its own neutrals.
 * `loading`: the boot heartbeat. Blood runs down each vessel into the core, the core beats, repeat until loaded.
 */
export function Mark({ size, lit, loading = false, stroke = 1.5 }: { size: number; lit?: Lit; loading?: boolean; stroke?: number }) {
  const setup = !!lit;
  const sats = Object.entries(SATS) as [Sat, (typeof SATS)[Sat]][];
  // Stroke widths in viewBox units (not non-scaling-stroke: dashes would then be measured in pixels, not pathLength).
  const vbw = setup ? 184 : 140;
  const sw = stroke * vbw / size;
  return (
    <svg className={`mark ${setup ? 'setup' : ''} ${loading ? 'loading' : ''}`} viewBox={setup ? '-12 -4 184 176' : '10 20 140 125'}
      width={size} height={setup ? size * 176 / 184 : size * 125 / 140} aria-hidden>
      {sats.map(([k, s], i) => (
        <g key={k} className={lit?.[k] ? 'lit' : ''}>
          <path className="m-edge" d={s.edge} pathLength={1} strokeWidth={sw} style={{ animationDelay: `${i * 100}ms` }} />
          {setup && <path className="m-flow" d={s.edge} pathLength={1} strokeWidth={sw * 1.25} />}
          <circle className="m-node sat" cx={s.x} cy={s.y} r={s.r} style={{ animationDelay: `${60 + i * 90}ms` }} />
          {setup && <text className="m-label" x={s.lx} y={s.ly} textAnchor="middle">{s.label}</text>}
        </g>
      ))}
      <circle className={`m-node core ${lit?.core ? 'lit' : ''}`} cx={CORE.x} cy={CORE.y} r={CORE.r} />
    </svg>
  );
}

// ---------------------------------------------------------------- boot

export function Boot({ leaving }: { leaving: boolean }) {
  return (
    <div className={`boot ${leaving ? 'leaving' : ''}`} role="status" aria-label="Plexus is loading">
      <Mark size={64} loading />
    </div>
  );
}

// ---------------------------------------------------------------- setup

interface ToolStatus { found: boolean; version: string | null; path: string | null }
interface SetupChecks { git: ToolStatus; claude: ToolStatus; codex: ToolStatus; platform: string }

const INSTALL: { tool: 'claude' | 'codex'; name: string; command: string }[] = [
  { tool: 'claude', name: 'Claude Code', command: 'npm install -g @anthropic-ai/claude-code' },
  { tool: 'codex', name: 'Codex', command: 'npm install -g @openai/codex' },
];
const PROVIDER_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/** States that mean the CLI accepted the account's credentials. */
const SIGNED_IN = new Set(['ok', 'warning', 'limited', 'transient']);

export function Onboarding({ accounts, reloadAccounts, onDone, onError }: {
  accounts: Account[]; reloadAccounts: () => void; onDone: (skipped: boolean) => void; onError: (e: string) => void;
}) {
  const [phase, setPhase] = useState<'welcome' | 'setup'>('welcome');
  const [checks, setChecks] = useState<SetupChecks | null>(null);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<Account | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [confirmSkip, setConfirmSkip] = useState(false);

  const check = useCallback(() => {
    setChecking(true);
    return api<SetupChecks>('POST', '/api/setup/check').then(setChecks).catch(e => onError(e.message)).finally(() => setChecking(false));
  }, [onError]);
  useEffect(() => { void check(); }, [check]);

  // Accounts the daemon has not checked yet: ask the CLI (free) whether they are signed in.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    const unknown = accounts.filter(a => a.provider !== 'mock' && a.state === 'unknown' && !asked.current.has(a.id));
    unknown.forEach(a => asked.current.add(a.id));
    if (unknown.length) void Promise.all(unknown.map(a => api('POST', `/api/accounts/${a.id}/login-status`).catch(() => {}))).then(reloadAccounts);
  }, [accounts, reloadAccounts]);

  // While a sign-in window is open, check every few seconds until it went through.
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => {
      void api<{ loggedIn: boolean | null }>('POST', `/api/accounts/${pending.id}/login-status`).then(r => {
        if (r.loggedIn) { setPending(null); setCommand(null); reloadAccounts(); }
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [pending, reloadAccounts]);

  const signIn = async (provider: Provider) => {
    try {
      const a = accounts.find(x => x.provider === provider && !SIGNED_IN.has(x.state)) ?? await api<Account>('POST', '/api/accounts', { provider });
      const r = await api<{ opened: boolean; command: string }>('POST', `/api/accounts/${a.id}/login`);
      setCommand(r.opened ? null : r.command);
      setPending(a);
      reloadAccounts();
    } catch (e: any) { onError(e.message); }
  };

  const install = (tool: string) => api<{ opened: boolean; command: string }>('POST', '/api/setup/install', { tool })
    .then(r => { if (!r.opened) setCommand(r.command); }).catch(e => onError(e.message));

  const signedIn = accounts.filter(a => a.provider !== 'mock' && a.enabled && SIGNED_IN.has(a.state));
  const gitOk = !!checks?.git.found;
  const clis = INSTALL.filter(i => checks?.[i.tool].found);
  const cliOk = clis.length > 0;
  const acctOk = signedIn.length > 0;
  const allOk = gitOk && cliOk && acctOk;
  const lit: Lit = { git: gitOk, cli: cliOk, account: acctOk, core: allOk };
  const win = checks?.platform === 'win32';

  const recheck = <button onClick={() => void check()} disabled={checking}><Ic i={RotateCw} />{checking ? 'Checking' : 'Check again'}</button>;

  return (
    <div className="onboarding" role="dialog" aria-label="Set up Plexus">
      <div className="ob-left" key={phase}>
        {phase === 'welcome' ? (
          <>
            <h1 className="ob-title">Hi, I'm Plexus</h1>
            <p className="ob-tagline">The bloodstream of your agents</p>
            <p className="ob-lead">Before your first project, Plexus checks that this machine has what agents need: Git, a coding CLI and one signed-in account</p>
            <div className="ob-actions"><button className="primary lg" autoFocus onClick={() => setPhase('setup')}>Set up<Ic i={ArrowRight} /></button></div>
          </>
        ) : (
          <>
            <h1 className="ob-heading">Set up this machine</h1>
            <p className="ob-sub">Plexus needs all three before it can start a task</p>
            <ol className="steps">
              <Step n={1} title="Git" done={gitOk} loading={!checks} meta={gitOk ? `git ${checks!.git.version ?? ''}` : checks ? 'Not found' : 'Checking'}>
                <p>Every agent works in its own git worktree, so Plexus needs Git on this machine</p>
                <div className="step-actions">
                  <a className="button" href="https://git-scm.com/downloads" target="_blank" rel="noreferrer"><Ic i={ExternalLink} />Download Git</a>
                  {recheck}
                </div>
              </Step>

              <Step n={2} title="Coding CLI" done={cliOk} loading={!checks}
                meta={cliOk ? clis.map(c => `${c.name} ${checks![c.tool].version ?? ''}`.trim()).join(' · ') : checks ? 'Not found' : 'Checking'}>
                <p>Agents run through Claude Code or Codex. One of them is enough</p>
                <div className="cmds">
                  {INSTALL.map(i => <Cmd key={i.tool} name={i.name} command={i.command} onInstall={win ? () => void install(i.tool) : undefined} />)}
                </div>
                <p className="step-note">Both install with npm, which comes with <a href="https://nodejs.org" target="_blank" rel="noreferrer">Node.js</a></p>
                <div className="step-actions">{recheck}</div>
              </Step>

              <Step n={3} title="Sign in" done={acctOk} blocked={!cliOk}
                meta={acctOk ? signedIn.map(a => a.label).join(' · ') : cliOk ? 'No account yet' : 'Needs a CLI'}>
                <p>Sign in to at least one account. Plexus opens the sign-in in a terminal, then your browser</p>
                {pending ? (
                  <div className="waiting" role="status">
                    <span className="live-dot" />Waiting for the {PROVIDER_NAME[pending.provider]} sign-in to finish
                    <button className="link-btn" onClick={() => { setPending(null); setCommand(null); }}>Cancel</button>
                  </div>
                ) : (
                  <div className="step-actions">
                    {clis.map(c => <button key={c.tool} onClick={() => void signIn(c.tool)}>Sign in with {PROVIDER_NAME[c.tool]}</button>)}
                  </div>
                )}
              </Step>
            </ol>
            {command && <div className="cmds standalone"><Cmd name="Run in a terminal" command={command} /></div>}

            {confirmSkip ? (
              <div className="skip-warn" role="alert">
                <p>{acctOk
                  ? 'Plexus cannot start a project without Git. You can run setup again from Settings → Advanced'
                  : 'Plexus can’t start any task until one account is signed in. You can add one later in Settings → Accounts'}</p>
                <div className="step-actions">
                  <button onClick={() => onDone(true)}>Skip for now</button>
                  <button className="primary" autoFocus onClick={() => setConfirmSkip(false)}>Back to setup</button>
                </div>
              </div>
            ) : (
              <div className="ob-footer">
                <button className="ghost" onClick={() => (allOk ? onDone(false) : setConfirmSkip(true))}>Skip setup</button>
                <span className="spacer" />
                <button className="primary lg" disabled={!allOk} onClick={() => onDone(false)}>Open Plexus<Ic i={ArrowRight} /></button>
              </div>
            )}
          </>
        )}
      </div>
      <div className="ob-visual"><Mark size={360} lit={lit} stroke={2} /></div>
    </div>
  );
}

function Step({ n, title, meta, done, blocked = false, loading = false, children }: {
  n: number; title: string; meta: string; done: boolean; blocked?: boolean; loading?: boolean; children: ReactNode;
}) {
  const state = done ? 'done' : blocked ? 'blocked' : loading ? 'loading' : 'todo';
  return (
    <li className={`step ${state}`} aria-label={`Step ${n}: ${title}`}>
      <div className="step-head">
        <span className="step-node" aria-hidden />
        <span className="step-title">{title}</span>
        <span className="step-meta mono">{done && <Ic i={Check} size={14} />}{meta}</span>
      </div>
      {state === 'todo' && <div className="step-body">{children}</div>}
    </li>
  );
}

function Cmd({ name, command, onInstall }: { name: string; command: string; onInstall?: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard?.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  return (
    <div className="cmd">
      <span className="cmd-name">{name}</span>
      <code className="cmd-line">{command}</code>
      <button className="icon-btn" onClick={copy} title={copied ? 'Copied' : 'Copy command'} aria-label="Copy command"><Ic i={copied ? Check : Copy} /></button>
      {onInstall && <button className="icon-btn" onClick={onInstall} title="Run in a terminal" aria-label={`Install ${name} in a terminal`}><Ic i={SquareTerminal} /></button>}
    </div>
  );
}
