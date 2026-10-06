const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

function store() {
  const code = buildSync({ entryPoints: ['src/store.js'], bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['zustand'] }).outputFiles[0].text;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console,
    setTimeout: () => 1, clearTimeout() {}, window: { api: {
      hosts: { save: async () => {} }, convos: { save: async () => {} }
    } } });
  const original = { id: 'c', hostId: 'h', cwd: '/workspace', messages: [{ text: 'remember this' }],
    claudeSessionId: 'claude-original', codexSessionId: 'codex-original', codexStarted: true };
  mod.exports.useStore.setState({ hosts: [{ id: 'h', host: '10.1.6.230', port: 22 }],
    conversations: { c: original }, activeConvByHost: { h: 'c' } });
  return { ...mod.exports, original };
}

test('editing connection address preserves conversation, history and exact resume ids', async () => {
  const { useStore, saveHosts, original } = store();
  await saveHosts([{ id: 'h', host: 'ssh.chencytech.com', port: 23022 }]);
  assert.equal(useStore.getState().conversations.c, original);
  assert.equal(useStore.getState().activeConvByHost.h, 'c');
});

test('partial resume updates preserve other engine identifiers; explicit resets still work', () => {
  const { useStore } = store();
  useStore.getState().updateConvResume('c', { codexStarted: true });
  assert.equal(useStore.getState().conversations.c.codexSessionId, 'codex-original');
  assert.equal(useStore.getState().conversations.c.claudeSessionId, 'claude-original');
  useStore.getState().updateConvResume('c', { codexSessionId: null, codexStarted: false });
  assert.equal(useStore.getState().conversations.c.codexSessionId, null);
  assert.equal(useStore.getState().conversations.c.codexStarted, false);
});
