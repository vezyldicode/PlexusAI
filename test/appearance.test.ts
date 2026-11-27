import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTheme, applyUserColor, readTheme, readUserColor, saveTheme, saveUserColor, USER_COLORS } from '../ui/src/appearance.ts';

test('theme defaults, persistence and message colors remain independent', () => {
  const storage = new Map<string, string>();
  const properties = new Map<string, string>();
  const root = { dataset: {} as Record<string, string>, style: {
    setProperty: (k: string, v: string) => properties.set(k, v),
    removeProperty: (k: string) => properties.delete(k),
  } };
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
    } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: root } });
    assert.equal(readTheme(), 'dark');
    storage.set('plexus.appearance.theme', 'invalid');
    assert.equal(readTheme(), 'dark');
    for (const color of USER_COLORS) {
      saveUserColor(color.id);
      const before = [...properties];
      for (const theme of ['light', 'dark'] as const) {
        saveTheme(theme);
        assert.equal(root.dataset.theme, theme);
        assert.equal(readTheme(), theme);
        assert.equal(readUserColor(), color.id);
        assert.deepEqual([...properties], before);
        // Reapply persisted preferences as startup does after reload.
        root.dataset.theme = '';
        properties.clear();
        applyTheme(readTheme());
        applyUserColor(readUserColor());
        assert.equal(root.dataset.theme, theme);
        assert.deepEqual([...properties], before);
      }
    }
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage denied'); } });
    assert.equal(readTheme(), 'dark');
    assert.doesNotThrow(() => saveTheme('light'));
    assert.equal(root.dataset.theme, 'light');
  } finally {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
