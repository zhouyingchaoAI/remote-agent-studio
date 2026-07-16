const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('task store provides immutable research, implementation, and review templates', () => {
  const store = read('src/store.js');
  assert.match(store, /export const TASK_TEMPLATES/);
  for (const template of ['research', 'implementation', 'review']) assert.match(store, new RegExp(`id: '${template}'`));
  assert.match(store, /templateId: fields\.templateId \|\| 'implementation'/);
  assert.match(store, /stages: createTaskStages\(fields\.templateId \|\| 'implementation'/);
});

test('task stages record explicit cwd and conversation handoff fields', () => {
  const store = read('src/store.js');
  assert.match(store, /startTaskStage:\s*\(taskId, stageId, fields = \{\}\)/);
  assert.match(store, /cwd: fields\.cwd \|\| stage\.cwd \|\| ''/);
  assert.match(store, /convId: fields\.convId \|\| stage\.convId \|\| null/);
  assert.match(store, /type: 'stage_started'/);
});

test('chat task creation exposes an explicit template choice', () => {
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /TASK_TEMPLATES/);
  assert.match(chat, /setTaskTemplate/);
  assert.match(chat, /templateId: taskTemplate/);
});
