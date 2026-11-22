import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account, AcceptanceItemLike, ChatMessage, ChatStep, ChatSession, Project, ProjectUsage, Task, TaskModelInfo } from './types.ts';
import { api, connectEvents, type PlexusEvent } from './api.ts';
import { parsePlan, planLine, type PlanItem } from './activity.tsx';

/**
 * What the coordinator is doing in a chat session while it answers: its tool calls so far, its steps in order (the words
 * it writes between tool calls included), its checklist, and when it started (ms).
 */
export interface LiveActivity { tools: string[]; steps: ChatStep[]; plan: PlanItem[] | null; since: number }

const freshLive = (since = Date.now()): LiveActivity => ({ tools: [], steps: [], plan: null, since });

export interface LogLine { at: string; taskSeq: number; taskId: string; account: string; kind: string; text: string }

/** Set while work is ready but no account can take it (issue #5). */
export interface Waiting { since: string; nextReset: string | null; tasks: number }
export interface ProjectDetail { project: Project; tasks: Task[]; counts: Record<string, number>; acceptance: AcceptanceItemLike[]; waiting: Waiting | null; usage: ProjectUsage; models?: Record<string, TaskModelInfo> }

export function usePlexus(selectedId: string | null) {
  const [projects, setProjects] = useState<(Project & { counts: Record<string, number> })[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  /** Latest output line per task, for the network hover card. */
  const [lastLine, setLastLine] = useState<Record<string, LogLine>>({});
  /** Bumped on every task.log event of the selected project, so open agent tabs can refresh. */
  const [logTick, setLogTick] = useState(0);
  const [activity, setActivity] = useState<PlexusEvent[]>([]);
  const [connected, setConnected] = useState(false);
  /** Chat sessions of the selected project, and the one on screen. */
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionIdState] = useState<string | null>(null);
  /** Account the coordinator is thinking on, per chat session id. */
  const [thinking, setThinking] = useState<Record<string, string>>({});
  const [live, setLive] = useState<Record<string, LiveActivity>>({});
  const [error, setError] = useState<string | null>(null);
  const sel = useRef(selectedId);
  sel.current = selectedId;
  const curSession = useRef<string | null>(null);
  curSession.current = sessionId;
  const timers = useRef<Record<string, number>>({});

  const debounce = (key: string, fn: () => void, ms = 250) => {
    clearTimeout(timers.current[key]);
    timers.current[key] = window.setTimeout(fn, ms);
  };

  const loadProjects = useCallback(() => api('GET', '/api/projects').then(setProjects).catch(e => setError(e.message)), []);
  const loadAccounts = useCallback(() => api('GET', '/api/accounts').then(setAccounts).catch(e => setError(e.message)), []);
  const loadDetail = useCallback(() => {
    const id = sel.current;
    if (!id) { setDetail(null); return; }
    api<ProjectDetail>('GET', `/api/projects/${id}`).then(d => {
      // Tolerate a daemon from before these fields existed.
      d.tasks = d.tasks.map(t => ({ ...t, paths: t.paths ?? [], models: t.models ?? {} }));
      d.waiting ??= null;
      d.usage ??= { total: null, tasks: {}, byRole: {}, coordinator: null };
      if (sel.current === id) setDetail(d);
    }).catch(e => { if (!/no such project/.test(e.message)) setError(e.message); setDetail(null); });
  }, []);
  const loadMessages = useCallback(() => {
    const id = sel.current;
    if (!id) { setMessages([]); return; }
    const sid = curSession.current;
    if (!sid) { setMessages([]); return; }
    api<ChatMessage[]>('GET', `/api/projects/${id}/messages?session=${sid}`).then(m => { if (sel.current === id && curSession.current === sid) setMessages(m); });
  }, []);
  const loadSessions = useCallback(() => {
    const id = sel.current;
    if (!id) { setSessions([]); setSessionIdState(null); return; }
    api<ChatSession[]>('GET', `/api/projects/${id}/chat-sessions`).then(list => {
      if (sel.current !== id) return;
      setSessions(list);
      // Keep the open session; otherwise the one used last in this project, otherwise the most recent.
      const cur = curSession.current;
      if (cur && list.some(x => x.id === cur)) return;
      let remembered: string | null = null;
      try { remembered = localStorage.getItem(`plexus.chat.${id}`); } catch { /* ignore */ }
      setSessionIdState(list.find(x => x.id === remembered)?.id ?? list[0]?.id ?? null);
    }).catch(() => {});
  }, []);
  const setSessionId = useCallback((sid: string) => {
    if (sel.current) { try { localStorage.setItem(`plexus.chat.${sel.current}`, sid); } catch { /* ignore */ } }
    setSessionIdState(sid);
  }, []);

  /** True once the first projects and accounts reads have settled (the boot screen waits for it). */
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { void Promise.allSettled([loadProjects(), loadAccounts()]).then(() => setLoaded(true)); }, [loadProjects, loadAccounts]);
  useEffect(() => {
    setLogs([]); setLastLine({}); setThinking({}); setSessions([]); setSessionIdState(null); setMessages([]);
    loadDetail(); loadSessions();
    if (selectedId) api<PlexusEvent[]>('GET', `/api/projects/${selectedId}/events?limit=150`).then(setActivity).catch(() => {});
    else setActivity([]);
  }, [selectedId, loadDetail, loadSessions]);
  useEffect(() => { loadMessages(); }, [sessionId, loadMessages]);

  useEffect(() => connectEvents(e => {
    if (e.type.startsWith('account.')) debounce('accounts', loadAccounts);
    if (e.type.startsWith('project.')) debounce('projects', loadProjects);
    if (e.projectId && e.projectId !== sel.current) {
      if (e.type.startsWith('task.')) debounce('projects', loadProjects, 1000);
      return;
    }
    if (e.type === 'task.log') {
      // A checklist arrives as its JSON list; logs and the network card show it as one line.
      const plan = e.data.kind === 'plan' ? parsePlan(e.data.text) : null;
      const line: LogLine = { at: e.createdAt, taskSeq: e.data.seq, taskId: e.data.id, account: e.data.account, kind: e.data.kind, text: plan ? planLine(plan) : e.data.text };
      setLogs(l => [...l.slice(-800), line]);
      if (line.kind !== 'raw') setLastLine(m => ({ ...m, [line.taskId]: line }));
      debounce('logtick', () => setLogTick(x => x + 1), 400);
      return;
    }
    if (e.type === 'chat.thinking') {
      setThinking(t => { const { [e.data.sessionId]: _gone, ...rest } = t; return e.data.thinking ? { ...rest, [e.data.sessionId]: e.data.account } : rest; });
      // The reply carries what was done (its meta.activity) from here on.
      if (!e.data.thinking) setLive(l => { const { [e.data.sessionId]: _gone, ...rest } = l; return rest; });
      else setLive(l => ({ ...l, [e.data.sessionId]: l[e.data.sessionId] ?? freshLive() }));
      return;
    }
    if (e.type === 'chat.activity') {
      const sid: string = e.data.sessionId;
      setLive(l => {
        // A retry starts its steps over, but the clock keeps counting from the first attempt.
        const cur = e.data.reset ? freshLive(l[sid]?.since) : l[sid] ?? freshLive();
        if (e.data.kind === 'plan') return { ...l, [sid]: { ...cur, plan: parsePlan(e.data.text) ?? cur.plan } };
        if (e.data.kind === 'tool') return { ...l, [sid]: { ...cur, tools: [...cur.tools, e.data.text], steps: [...cur.steps, { kind: 'tool', text: e.data.text }] } };
        if (e.data.kind === 'text') return { ...l, [sid]: { ...cur, steps: [...cur.steps, { kind: 'text', text: e.data.text }] } };
        return { ...l, [sid]: cur };
      });
      return;
    }
    if (e.type === 'chat.session') { debounce('sessions', loadSessions, 100); return; }
    if (e.type === 'chat.message' || e.type === 'chat.updated') {
      if (e.data.sessionId === curSession.current) debounce('messages', loadMessages, 100);
      debounce('sessions', loadSessions, 100);
      return;
    }
    if (e.id) setActivity(a => [...a.slice(-300), e]);
    if (e.type.startsWith('task.') || e.type.startsWith('project.') || e.type === 'memory.updated') { debounce('detail', loadDetail); debounce('projects', loadProjects, 800); }
  }, ok => { setConnected(ok); if (ok) { loadAccounts(); loadProjects(); loadDetail(); loadSessions(); loadMessages(); } }), [loadAccounts, loadProjects, loadDetail, loadMessages, loadSessions]);

  // Clock tick so "x minutes ago" stays fresh.
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 5000); return () => clearInterval(t); }, []);

  return { loaded, projects, accounts, detail, messages, sessions, sessionId, setSessionId, loadSessions, logs, lastLine, logTick, activity, connected, thinking, live, error, setError, loadProjects, loadAccounts, loadDetail, loadMessages };
}

export type Plexus = ReturnType<typeof usePlexus>;
