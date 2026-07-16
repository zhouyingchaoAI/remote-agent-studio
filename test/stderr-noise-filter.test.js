const test = require('node:test');
const assert = require('node:assert/strict');

const { filterStderrNoise } = require('../electron/ssh/AgentSession');

test('tracing-style log lines are filtered out of chat bubbles', () => {
  const input = [
    '2026-07-15T05:55:46.293297Z ERROR codex_models_manager::manager: failed to refresh available models',
    '2026-07-15T05:55:50.205755Z ERROR codex_api::endpoint::responses_websocket: failed to connect',
    '2026-07-15T05:56:13Z  WARN something transient'
  ].join('\n');
  assert.equal(filterStderrNoise(input), '');
});

test('meaningful stderr like login prompts is preserved', () => {
  const input = [
    'Reading additional input from stdin...',
    '2026-07-15T05:55:46Z ERROR noisy tracing line',
    'Error: not logged in. Run codex login first.'
  ].join('\n');
  const out = filterStderrNoise(input);
  assert.ok(out.includes('Reading additional input'));
  assert.ok(out.includes('not logged in'));
  assert.ok(!out.includes('noisy tracing line'));
});
