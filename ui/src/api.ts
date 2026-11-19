declare const __DEV_TOKEN__: string;
declare global { interface Window { SWARM_TOKEN?: string } }

export const token: string = window.SWARM_TOKEN || __DEV_TOKEN__ || new URLSearchParams(location.search).get('token') || '';

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-swarm-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

export interface SwarmEvent { id: number; projectId: string | null; type: string; data: any; createdAt: string }

/** WebSocket with automatic reconnect. */
export function connectEvents(onEvent: (e: SwarmEvent) => void, onStatus: (connected: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: number | undefined;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => onStatus(true);
    ws.onmessage = m => { try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ } };
    ws.onclose = () => { onStatus(false); if (!closed) retry = window.setTimeout(open, 2000); };
  };
  open();
  return () => { closed = true; clearTimeout(retry); ws?.close(); };
}

export const timeAgo = (iso?: string | null) => {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 0) { const f = -s; return f < 3600 ? `in ${Math.round(f / 60)}m` : `in ${(f / 3600).toFixed(1)}h`; }
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export const clock = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
