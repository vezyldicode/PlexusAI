import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeClaudeEvent, describeClaudeEvents } from '../src/server/adapters/claude.ts';
import { chatProse } from '../src/server/coordinator.ts';
import { describeCodexEvent } from '../src/server/adapters/codex.ts';
import { parsePlan } from '../src/server/adapters/plan.ts';

const claudeTool = (name: string, input: unknown) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

test('claude: plexus_plan becomes a plan event', () => {
  const e = describeClaudeEvent(claudeTool('mcp__plexus__plexus_plan', { items: [{ step: 'Read code', status: 'completed' }, { step: 'Fix bug', status: 'in_progress' }, { step: 'Test', status: 'pending' }] }));
  assert.equal(e?.kind, 'plan');
  assert.deepEqual(parsePlan(e!.text), [
    { text: 'Read code', status: 'completed' }, { text: 'Fix bug', status: 'in_progress' }, { text: 'Test', status: 'pending' },
  ]);
});

test('claude: TodoWrite becomes a plan event, other tools stay tools', () => {
  const e = describeClaudeEvent(claudeTool('TodoWrite', { todos: [{ content: 'A', status: 'in_progress', activeForm: 'Doing A' }] }));
  assert.equal(e?.kind, 'plan');
  assert.deepEqual(parsePlan(e!.text), [{ text: 'A', status: 'in_progress' }]);
  assert.deepEqual(describeClaudeEvent(claudeTool('Bash', { command: 'npm test' })), { kind: 'tool', text: 'Bash npm test' });
});

test('codex: todo_list and plexus_plan become plan events, other mcp calls are tools', () => {
  const todo = describeCodexEvent(JSON.stringify({ type: 'item.updated', item: { id: 'i1', type: 'todo_list', items: [{ text: 'A', completed: true }, { text: 'B', completed: false }] } }));
  assert.deepEqual(parsePlan(todo!.text), [{ text: 'A', status: 'completed' }, { text: 'B', status: 'pending' }]);
  const plan = describeCodexEvent(JSON.stringify({ type: 'item.started', item: { id: 'i2', type: 'mcp_tool_call', server: 'plexus', tool: 'plexus_plan', arguments: { items: [{ step: 'X', status: 'in_progress' }] }, status: 'in_progress' } }));
  assert.equal(plan?.kind, 'plan');
  const status = describeCodexEvent(JSON.stringify({ type: 'item.started', item: { id: 'i3', type: 'mcp_tool_call', server: 'plexus', tool: 'plexus_task', arguments: { id: 'T5' }, status: 'in_progress' } }));
  assert.deepEqual(status, { kind: 'tool', text: 'plexus_task T5' });
  // The completed call repeats the start: shown once.
  assert.equal(describeCodexEvent(JSON.stringify({ type: 'item.completed', item: { id: 'i3', type: 'mcp_tool_call', tool: 'plexus_task', arguments: {} } })), null);
});

test('a plan without usable steps is no plan', () => {
  assert.equal(describeClaudeEvent(claudeTool('mcp__plexus__plexus_plan', { items: [] }))?.kind, 'tool');
  assert.equal(parsePlan('nope'), null);
});

test('claude: words and every tool call of one message come through in order', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Reading the store first.' },
    { type: 'tool_use', name: 'Read', input: { file_path: 'ui/src/store.ts' } },
    { type: 'tool_use', name: 'Grep', input: { pattern: 'chat.activity' } },
    { type: 'text', text: 'Then the panel.' },
  ] } });
  assert.deepEqual(describeClaudeEvents(line).map(e => e.kind), ['text', 'tool', 'tool', 'text']);
  assert.equal(describeClaudeEvents(line)[0].text, 'Reading the store first.');
});

test('coordinator: its JSON answer is not shown as progress', () => {
  assert.equal(chatProse('{ "reply": "Done", "actions": [] }'), '');
  assert.equal(chatProse('Looked at it.\n```json\n{ "reply": "Done" }\n```'), 'Looked at it.');
  assert.equal(chatProse('Checking the **board** now'), 'Checking the **board** now');
});
