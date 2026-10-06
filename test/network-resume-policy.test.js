const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { buildSync } = require('esbuild');

test('reconnected host does not replay delayed automatic prompts until the user continues', async () => {
  const code = buildSync({ entryPoints: ['src/store.js'], bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['zustand'] }).outputFiles[0].text;
  const mod = { exports: {} }, sent = [];
  let prepared;
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console,
    setTimeout: () => 1, clearTimeout() {},
    window: { api: { agent: { send: async (input) => sent.push(input) },
      attachments: { prepare: () => new Promise(resolve => { prepared = resolve; }) },
      convos: { save: async () => {} } } }
  });
  const { useStore, sendToAgent } = mod.exports;
  useStore.setState({ conversations: { c: { id: 'c', hostId: 'h', agent: 'codex', messages: [] } } });
  useStore.getState().setStatus('h', 'connected', '', true);
  useStore.getState().setStatus('h', 'error', 'ECONNRESET', true);
  useStore.getState().setStatus('h', 'connected', '', true);
  await sendToAgent('h', 'c', 'automatic retry', [], { auto: true });
  assert.equal(sent.length, 0, 'a stale auto-resume timer must not replay work after reconnection');
  assert.equal(useStore.getState().connectionPaused.c, true);
  await sendToAgent('h', 'c', 'continue manually');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].prompt, 'continue manually');
  assert.equal(useStore.getState().connectionPaused.c, false);
  const queued = sendToAgent('h', 'c', 'queued attachment', ['file.png']);
  useStore.getState().setStatus('h', 'error', 'ECONNRESET', true);
  useStore.getState().setStatus('h', 'connected', '', true);
  prepared([]); await queued;
  assert.equal(sent.length, 1, 'a send preparing attachments must not slip past a disconnect');
});

test('goal continuation rechecks pause after asynchronous plan refresh', async () => {
  // Run the actual deferred callback, with only IPC and goal decisions stubbed.
  const app = fs.readFileSync('src/App.jsx', 'utf8');
  const start = app.indexOf('const goalStep = () => {');
  const end = app.indexOf('\n        };', start) + '\n        };'.length;
  const state = { connectionPaused: { c: false }, conversations: { c: {
    hostId: 'h', messages: [], goal: { status: 'active', text: 'test' }
  } }, pushMessage() {} };
  let checks = 0;
  const callback = vm.runInNewContext(app.slice(start, end) + '\ngoalStep', {
    useStore: { getState: () => state }, convId: 'c', danger: null,
    decideGoalStep: () => ({ action: 'check', command: 'echo check' }),
    window: { api: { goal: { check: () => { checks++; return new Promise(() => {}); } } } }
  });
  const pendingRefresh = Promise.resolve().then(callback);
  state.connectionPaused.c = true;
  await pendingRefresh;
  assert.equal(checks, 0, 'deferred verification command must not run after disconnect');
});
