import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// In dev the daemon is proxied; the API token is read from the Plexus data folder.
const root = process.platform === 'win32' ? process.env.APPDATA ?? '' : homedir();
const dir = (n: string) => join(root, process.platform === 'win32' ? n : `.${n}`);
const home = process.env.PLEXUS_HOME ?? (!existsSync(dir('plexus')) && existsSync(dir('swarm')) ? dir('swarm') : dir('plexus'));
const tokenFile = join(home, 'api-token');
const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
const port = process.env.PLEXUS_PORT ?? '4317';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: { __DEV_TOKEN__: JSON.stringify(command === 'serve' ? token : '') },
  server: { port: 5317, proxy: { '/api': { target: `http://127.0.0.1:${port}`, ws: true } } },
}));
