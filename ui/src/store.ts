import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account, AcceptanceItemLike, ChatMessage, ChatSession, Project, Task } from './types.ts';
import { api, connectEvents, type PlexusEvent } from './api.ts';

export interface LogLine { at: string; taskSeq: number; taskId: string; account: string; kind: string; text: string }

/** Set while work is ready but no account can take it (issue #5). */
export interface Waiting { since: string; nextReset: string | null; tasks: number }
export interface ProjectDetail { project: Project; tasks: Task[]; counts: Record<string, number>; acceptance: AcceptanceItemLike[]; waiting: Waiting | null }

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

  useEffect(() => { loadProjects(); loadAccounts(); }, [loadProjects, loadAccounts]);
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
      const line: LogLine = { at: e.createdAt, taskSeq: e.data.seq, taskId: e.data.id, account: e.data.account, kind: e.data.kind, text: e.data.text };
      setLogs(l => [...l.slice(-800), line]);
      if (line.kind !== 'raw') setLastLine(m => ({ ...m, [line.taskId]: line }));
      debounce('logtick', () => setLogTick(x => x + 1), 400);
      return;
    }
    if (e.type === 'chat.thinking') {
      setThinking(t => { const { [e.data.sessionId]: _gone, ...rest } = t; return e.data.thinking ? { ...rest, [e.data.sessionId]: e.data.account } : rest; });
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

  return { projects, accounts, detail, messages, sessions, sessionId, setSessionId, loadSessions, logs, lastLine, logTick, activity, connected, thinking, error, setError, loadProjects, loadAccounts, loadDetail, loadMessages };
}

export type Plexus = ReturnType<typeof usePlexus>;
