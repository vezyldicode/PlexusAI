import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropAction } from '../ui/src/board.ts';

test('board: failed, cancelled and blocked cards dropped on Queued are retried', () => {
  for (const s of ['failed', 'cancelled', 'blocked', 'interrupted', 'done'] as const) assert.equal(dropAction(s, 'Queued'), 'retry');
  assert.equal(dropAction('pending', 'Queued'), null);
  assert.equal(dropAction('running', 'Queued'), null);
});

test('board: pending, running and blocked cards dropped on Failed or cancelled are cancelled', () => {
  for (const s of ['pending', 'interrupted', 'blocked', 'running'] as const) assert.equal(dropAction(s, 'Failed or cancelled'), 'cancel');
  assert.equal(dropAction('done', 'Failed or cancelled'), null);
  assert.equal(dropAction('failed', 'Failed or cancelled'), null);
});

test('board: columns Plexus sets itself accept no drops', () => {
  for (const col of ['Waiting for you', 'Running', 'In review', 'Done'])
    for (const s of ['pending', 'running', 'failed', 'cancelled', 'blocked', 'done'] as const) assert.equal(dropAction(s, col), null);
});
