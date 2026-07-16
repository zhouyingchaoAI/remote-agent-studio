const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panel = fs.readFileSync(path.join(__dirname, '..', 'src/components/TaskPanel.jsx'), 'utf8');

test('review inbox filters pending approval and delivery-review tasks', () => {
  assert.match(panel, /const \[inboxOnly, setInboxOnly\]/);
  assert.match(panel, /\['needs_approval', 'review_ready'\]\.includes\(task\.status\)/);
  assert.match(panel, /Review Inbox/);
});

test('stage cards prepare an isolated worktree and open a dedicated conversation', () => {
  assert.match(panel, /window\.api\.worktrees\.create/);
  assert.match(panel, /createConversation\(task\.hostId/);
  assert.match(panel, /startTaskStage\(task\.id, stage\.id/);
  assert.match(panel, /准备隔离 worktree/);
});
