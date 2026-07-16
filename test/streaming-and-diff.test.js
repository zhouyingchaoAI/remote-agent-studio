const test = require('node:test');
const assert = require('node:assert/strict');

const { AgentSession } = require('../electron/ssh/AgentSession');

function collect(agent) {
  const events = [];
  const session = new AgentSession(null, null, { agent, permissionMode: 'workspace' });
  session.imagePaths = [];
  session.on('message', (m) => events.push(m));
  return { session, events };
}

test('codex legacy delta events stream as text/reasoning deltas', () => {
  const { session, events } = collect('codex');
  session._parseLine(JSON.stringify({ msg: { type: 'agent_message_delta', delta: '你' } }));
  session._parseLine(JSON.stringify({ msg: { type: 'agent_reasoning_delta', delta: '想' } }));
  assert.deepEqual(events.map((e) => e.kind), ['text_delta', 'reasoning_delta']);
});

test('codex new-format item.delta streams too', () => {
  const { session, events } = collect('codex');
  session._parseLine(JSON.stringify({ type: 'item.delta', delta: 'ab', item: { type: 'agent_message' } }));
  session._parseLine(JSON.stringify({ type: 'item.delta', delta: 'cd', item: { type: 'reasoning' } }));
  assert.deepEqual(events.map((e) => [e.kind, e.text]), [['text_delta', 'ab'], ['reasoning_delta', 'cd']]);
});

test('codex turn_diff renders as a diff message', () => {
  const { session, events } = collect('codex');
  session._parseLine(JSON.stringify({ msg: { type: 'turn_diff', unified_diff: '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y' } }));
  assert.equal(events[0].kind, 'diff');
  assert.match(events[0].text, /\+y/);
});

test('claude stream_event partial deltas stream as text/reasoning', () => {
  const { session, events } = collect('claude');
  session._parseLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '流' } } }));
  session._parseLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '思' } } }));
  assert.deepEqual(events.map((e) => [e.kind, e.text]), [['text_delta', '流'], ['reasoning_delta', '思']]);
});

test('claude Edit tool_use carries old/new diff payload', () => {
  const { session, events } = collect('claude');
  session._parseLine(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a.js', old_string: 'foo', new_string: 'bar' } }] }
  }));
  assert.equal(events[0].kind, 'tool');
  assert.deepEqual(events[0].diff, { old: 'foo', new: 'bar' });
});

test('claude command enables partial message streaming', () => {
  const session = new AgentSession(null, null, { agent: 'claude', cwd: '/w', permissionMode: 'workspace' });
  assert.match(session.buildCommand('hi'), /--include-partial-messages/);
});

test('unix commands report the shell pid and exec the agent for precise cancellation', () => {
  const session = new AgentSession(null, null, { agent: 'codex', cwd: '/w', permissionMode: 'workspace' });
  const command = session.buildCommand('hi');
  assert.match(command, /__RAS_PID_\$\$__/);
  assert.match(command, /exec codex exec/);
  assert.match(command, /<\/dev\/null/);
});

test('pid marker lines are captured, not rendered as chat messages', () => {
  const { session, events } = collect('codex');
  session._parseLine('__RAS_PID_12345__');
  assert.equal(session.remotePid, 12345);
  assert.equal(events.length, 0);
});

test('codex turn.completed usage aggregates into a usage message', () => {
  const { session, events } = collect('codex');
  session._parseLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 30 } }));
  assert.deepEqual(events[0], { kind: 'usage', inputTokens: 150, outputTokens: 30 });
});

test('claude result carries usage and cost', () => {
  const { session, events } = collect('claude');
  session._parseLine(JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 5 }, duration_ms: 800 }));
  assert.equal(events[0].kind, 'usage');
  assert.equal(events[0].costUsd, 0.12);
  assert.equal(events[1].kind, 'result');
});
