// Swarm desktop shell.
// The daemon (src/server) runs as its own background process, started with Electron's built-in Node
// (ELECTRON_RUN_AS_NODE). This window is only a client of it: closing the window, or quitting the app,
// leaves the swarm running, exactly like closing the browser tab with `npm start`.
import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = Number(process.env.SWARM_PORT ?? 4317);
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** Folder holding src/server, defaults, ui/dist and the daemon's node_modules. */
const appRoot = app.isPackaged ? join(process.resourcesPath, 'app-root') : resolve(import.meta.dirname, '..', '..');
const iconPath = app.isPackaged ? join(process.resourcesPath, 'icon.png') : resolve(import.meta.dirname, '..', 'build', 'icon.png');

/** Same rule as src/server/paths.ts. */
function swarmHome(): string {
  return process.env.SWARM_HOME
    ?? (process.platform === 'win32' ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'swarm') : join(homedir(), '.swarm'));
}

// Electron's default userData on Windows is %APPDATA%\<productName> = %APPDATA%\Swarm, which is the daemon's
// data folder (case-insensitive). Keep Chromium's cache out of it.
app.setPath('userData', join(app.getPath('appData'), 'swarm-desktop'));

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let toldAboutBackground = false;

type Health = 'swarm' | 'other' | 'down';
async function health(): Promise<Health> {
  try {
    const r = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1500) });
    const j: any = await r.json().catch(() => null);
    return j?.app === 'multiagent-swarm' || j?.ok === true ? 'swarm' : 'other';
  } catch (e: any) {
    // A non-HTTP listener on the port also ends up here; a refused connection means nothing is there.
    return e?.cause?.code === 'ECONNREFUSED' || e?.name === 'TimeoutError' ? 'down' : 'other';
  }
}

/** Start the daemon as a detached background process, logging to <SWARM_HOME>/logs/daemon.log. */
function spawnDaemon(): void {
  const logs = join(swarmHome(), 'logs');
  mkdirSync(logs, { recursive: true });
  const out = openSync(join(logs, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [join(appRoot, 'src', 'server', 'main.ts')], {
    cwd: appRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWARM_PORT: String(PORT) },
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
}

/** Make sure a swarm daemon answers on PORT, starting one if needed. Returns an error message on failure. */
async function ensureDaemon(): Promise<string | null> {
  let h = await health();
  if (h === 'swarm') return null;
  if (h === 'other') return `Port ${PORT} is used by another program. Set the SWARM_PORT environment variable to another port and start Swarm again.`;
  if (!existsSync(join(appRoot, 'src', 'server', 'main.ts'))) return `Swarm files not found in ${appRoot}.`;
  spawnDaemon();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    h = await health();
    if (h === 'swarm') return null;
  }
  return `The swarm daemon did not start within 30 s. See ${join(swarmHome(), 'logs', 'daemon.log')}.`;
}

async function stopDaemon(): Promise<void> {
  // The token is injected into the UI page; reuse the daemon's own token file.
  try {
    const { readFileSync } = await import('node:fs');
    const token = readFileSync(join(swarmHome(), 'api-token'), 'utf8').trim();
    await fetch(`${ORIGIN}/api/shutdown`, { method: 'POST', headers: { 'x-swarm-token': token, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
  } catch { /* already down */ }
  for (let i = 0; i < 40 && (await health()) === 'swarm'; i++) await new Promise(r => setTimeout(r, 250));
}

function isInternal(url: string): boolean {
  try { return new URL(url).origin === ORIGIN; } catch { return false; }
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: 'Swarm', icon: iconPath, show: false, backgroundColor: '#1f2430',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.setMenuBarVisibility(false);
  // Links to other sites open in the default browser, never inside the app window.
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, url) => { if (!isInternal(url)) { e.preventDefault(); if (/^https?:/.test(url)) void shell.openExternal(url); } });
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) { e.preventDefault(); w.webContents.reload(); }
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) { e.preventDefault(); w.webContents.toggleDevTools(); }
  });
  // Daemon restarted or briefly unreachable: retry instead of leaving an error page.
  w.webContents.on('did-fail-load', (_e, code, _desc, url) => {
    if (code === -3 || !isInternal(url)) return; // -3 = aborted (e.g. a reload)
    setTimeout(() => { void ensureDaemon().then(err => { if (!err && !w.isDestroyed()) void w.loadURL(ORIGIN); }); }, 1500);
  });
  w.once('ready-to-show', () => w.show());
  // Closing the window keeps the app (and the swarm) running in the tray.
  w.on('close', e => {
    if (quitting || !tray) return;
    e.preventDefault();
    w.hide();
    if (!toldAboutBackground && process.platform === 'win32') {
      toldAboutBackground = true;
      tray.displayBalloon({ iconType: 'info', title: 'Swarm is still running', content: 'The swarm keeps working in the background. Open it again from the tray icon.' });
    }
  });
  w.on('closed', () => { if (win === w) win = null; });
  void w.loadURL(ORIGIN);
  return w;
}

async function showWindow(): Promise<void> {
  const err = await ensureDaemon();
  if (err) { dialog.showErrorBox('Swarm', err); return; }
  if (!win || win.isDestroyed()) win = createWindow();
  else {
    if (win.webContents.getURL() === '' || !isInternal(win.webContents.getURL())) void win.loadURL(ORIGIN);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function quitApp(): void { quitting = true; app.quit(); }

function buildTray(): void {
  const img = nativeImage.createFromPath(iconPath).resize({ width: process.platform === 'win32' ? 16 : 22 });
  tray = new Tray(img);
  tray.setToolTip('Swarm');
  const menu: MenuItemConstructorOptions[] = [
    { label: 'Open Swarm', click: () => void showWindow() },
    { label: 'Open data folder', click: () => void shell.openPath(swarmHome()) },
    { type: 'separator' },
    { label: 'Restart swarm', click: async () => { await stopDaemon(); await showWindow(); win?.webContents.reload(); } },
    { type: 'separator' },
    { label: 'Quit (swarm keeps running)', click: quitApp },
    { label: 'Stop swarm and quit', click: async () => { await stopDaemon(); quitApp(); } },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(menu));
  tray.on('click', () => void showWindow());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => void showWindow());
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    buildTray();
    await showWindow();
  });
  // The tray keeps the app alive; never quit just because the last window closed.
  app.on('window-all-closed', () => { /* stay in tray */ });
  app.on('before-quit', () => { quitting = true; });
}
