// Background of the user's own chat messages. A per-device preference, kept in localStorage.
// Each colour is a hue laid at 20% over the surface, so it reads as a dark tint on a dark theme and a pastel on a
// light one. Checked against both (#0f0f10 with #ededed / #a1a1a6 text, #ffffff with #1b1b1d / #5c5c63 text):
// primary text stays above 11:1, secondary text above 5:1, and the hairline in the same hue keeps the edge visible.

export type UserColor = { id: string; label: string; fill?: string; line?: string };

export const USER_COLORS: UserColor[] = [
  { id: 'graphite', label: 'Graphite' }, // the default: raised surface and neutral hairline
  { id: 'green', label: 'Green', fill: 'rgba(95, 207, 168, 0.2)', line: 'rgba(95, 207, 168, 0.32)' },
  { id: 'blue', label: 'Blue', fill: 'rgba(91, 159, 224, 0.2)', line: 'rgba(91, 159, 224, 0.32)' },
  { id: 'amber', label: 'Amber', fill: 'rgba(214, 162, 74, 0.2)', line: 'rgba(214, 162, 74, 0.32)' },
  { id: 'clay', label: 'Clay', fill: 'rgba(217, 119, 90, 0.2)', line: 'rgba(217, 119, 90, 0.32)' },
  { id: 'iris', label: 'Iris', fill: 'rgba(155, 139, 224, 0.2)', line: 'rgba(155, 139, 224, 0.32)' },
];

const KEY = 'plexus.chat.userColor';
const THEME_KEY = 'plexus.appearance.theme';
export type Theme = 'dark' | 'light';

export function readTheme(): Theme {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* still apply when storage is unavailable */ }
  applyTheme(theme);
}

export function readUserColor(): string {
  try { const v = localStorage.getItem(KEY); return USER_COLORS.some(c => c.id === v) ? v! : 'graphite'; } catch { return 'graphite'; }
}

/** Sets --user-bg / --user-line on the root; the default leaves them unset so the stylesheet's own values apply. */
export function applyUserColor(id: string) {
  const c = USER_COLORS.find(x => x.id === id) ?? USER_COLORS[0];
  const s = document.documentElement.style;
  if (c.fill) { s.setProperty('--user-bg', c.fill); s.setProperty('--user-line', c.line!); }
  else { s.removeProperty('--user-bg'); s.removeProperty('--user-line'); }
}

export function saveUserColor(id: string) {
  try { localStorage.setItem(KEY, id); } catch { /* ignore */ }
  applyUserColor(id);
}
