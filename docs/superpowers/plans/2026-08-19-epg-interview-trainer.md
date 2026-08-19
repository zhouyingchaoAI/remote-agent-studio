# EPG Interview Trainer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone local website for EPG interview memorization, typed-answer practice, and secure LLM feedback.

**Architecture:** `interview-trainer/` contains a Vite React client and a Node server. The browser owns study state in localStorage; the server owns model configuration and derives evaluation prompts from the server-side question bank.

**Tech Stack:** React 18, Vite, Node.js HTTP server, native `fetch`, Node test runner, CSS.

**Spec:** `docs/superpowers/specs/2026-08-19-epg-interview-trainer-design.md`

## Global Constraints

- Keep LLM credentials server-side in `interview-trainer/.env`; never prefix them with `VITE_`.
- Send the server only a question id and typed learner answer.
- Include all 33 supplied EPG questions.
- Treat 80 as the default weak-question threshold.
- No voice input or cloud persistence.

---

### Task 1: Scaffold the standalone application and its question bank

**Files:**
- Create: `interview-trainer/package.json`
- Create: `interview-trainer/index.html`
- Create: `interview-trainer/src/questionBank.js`
- Create: `interview-trainer/src/questionBank.test.js`
- Create: `interview-trainer/.gitignore`
- Create: `interview-trainer/.env.example`

**Interfaces:**
- Produces `QUESTIONS`, an immutable array of question records.
- Produces `getQuestionById(id)` which returns a question or `undefined`.

- [ ] **Step 1: Write the failing question-bank test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { QUESTIONS, getQuestionById } from './questionBank.js';

test('question bank contains 33 uniquely identified complete questions', () => {
  assert.equal(QUESTIONS.length, 33);
  assert.equal(new Set(QUESTIONS.map((item) => item.id)).size, 33);
  for (const item of QUESTIONS) {
    assert.ok(item.question.length > 0);
    assert.ok(item.memoryCue.length > 0);
    assert.ok(item.shortAnswer.length > 0);
    assert.ok(item.referenceAnswer.length > 0);
    assert.ok(item.keyPoints.length >= 2);
  }
});

test('getQuestionById returns a known question', () => {
  assert.equal(getQuestionById('epg-01').keyPoints[0], 'EPG组长');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd interview-trainer && npm test -- src/questionBank.test.js`

Expected: FAIL because `questionBank.js` does not exist.

- [ ] **Step 3: Create package metadata, config templates, and question bank**

```js
export const QUESTIONS = Object.freeze([{ id: 'epg-01', question: '您在过程改进中的角色和责任是什么？', memoryCue: '角色｜工作｜目的', shortAnswer: '我是EPG组长，负责改进过程，支撑业务目标。', referenceAnswer: '我是EPG组长……', keyPoints: ['EPG组长', '过程改进', '业务目标'] }]);
export const getQuestionById = (id) => QUESTIONS.find((item) => item.id === id);
```

Populate all 33 validated records. Set `type: module` and scripts `dev`, `build`, `start`, and `test`; ignore `.env` and `dist`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd interview-trainer && npm test -- src/questionBank.test.js`

Expected: PASS with two passing tests.

- [ ] **Step 5: Commit**

```bash
git add interview-trainer
git commit -m "feat(trainer): add question bank scaffold"
```

### Task 2: Implement secure evaluation request handling

**Files:**
- Create: `interview-trainer/server/evaluation.js`
- Create: `interview-trainer/server/evaluation.test.js`
- Create: `interview-trainer/server/server.js`

**Interfaces:**
- Consumes `getQuestionById(id)`.
- Produces `validateEvaluationInput(body)`, `normalizeEvaluation(data)`, and `createEvaluationPrompt(question, answer)`.
- Produces a `POST /api/evaluate` server route.

- [ ] **Step 1: Write failing evaluator tests**

```js
test('validates a usable question id and typed answer', () => {
  assert.deepEqual(validateEvaluationInput({ questionId: 'epg-01', answer: '这是一个不少于十个字符的回答。' }), { ok: true });
});

test('rejects a too-short answer', () => {
  assert.equal(validateEvaluationInput({ questionId: 'epg-01', answer: '太短' }).ok, false);
});

test('normalizes evaluation bounds and string arrays', () => {
  assert.deepEqual(normalizeEvaluation({ score: 110, coverage: -3, clarity: 81, matchedPoints: 'x' }), {
    score: 100, coverage: 0, clarity: 81, matchedPoints: [], missingPoints: [], feedback: '', improvedAnswer: ''
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd interview-trainer && npm test -- server/evaluation.test.js`

Expected: FAIL because `evaluation.js` does not exist.

- [ ] **Step 3: Implement pure evaluator helpers and the server route**

```js
export function validateEvaluationInput({ questionId, answer }) {
  return typeof questionId === 'string' && typeof answer === 'string' && answer.trim().length >= 10 && answer.length <= 3000
    ? { ok: true }
    : { ok: false, message: '回答需为 10–3000 个字符。' };
}
```

Load `.env` only in `server.js`, call `${LLM_BASE_URL.replace(/\/$/, '')}/v1/chat/completions` with an Authorization header, and return 400, 503, or 502 as described in the spec. Do not log headers or configuration values.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd interview-trainer && npm test -- server/evaluation.test.js`

Expected: PASS with all evaluator tests green.

- [ ] **Step 5: Commit**

```bash
git add interview-trainer/server interview-trainer/package.json
git commit -m "feat(trainer): add secure LLM evaluation endpoint"
```

### Task 3: Add learning-state helpers and persistence tests

**Files:**
- Create: `interview-trainer/src/progress.js`
- Create: `interview-trainer/src/progress.test.js`

**Interfaces:**
- Produces `recordAttempt(state, attempt)`, `toggleMastery(state, questionId, mastered)`, `getWeakQuestionIds(state, threshold = 80)`, and `getProgressSummary(state)`.

- [ ] **Step 1: Write failing progress tests**

```js
test('last score below 80 marks a question as weak', () => {
  const state = recordAttempt(emptyProgress(), { questionId: 'epg-01', score: 72, answer: '回答文本' });
  assert.deepEqual(getWeakQuestionIds(state), ['epg-01']);
});

test('mastered questions count in the progress summary', () => {
  const summary = getProgressSummary(toggleMastery(emptyProgress(), 'epg-01', true));
  assert.equal(summary.masteredCount, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd interview-trainer && npm test -- src/progress.test.js`

Expected: FAIL because `progress.js` does not exist.

- [ ] **Step 3: Implement immutable progress helpers**

Use `{ attempts: [], masteredIds: [] }` as the serialized state shape. Keep the latest attempt for weak-question selection; calculate average score from all attempts; use no browser APIs in this module.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd interview-trainer && npm test -- src/progress.test.js`

Expected: PASS with all progress tests green.

- [ ] **Step 5: Commit**

```bash
git add interview-trainer/src/progress.*
git commit -m "feat(trainer): add local learning progress helpers"
```

### Task 4: Build study, practice, feedback, and weak-review UI

**Files:**
- Create: `interview-trainer/src/main.jsx`
- Create: `interview-trainer/src/App.jsx`
- Create: `interview-trainer/src/styles.css`
- Create: `interview-trainer/vite.config.js`

**Interfaces:**
- Consumes `QUESTIONS`, `progress.js` helpers, and `/api/evaluate`.
- Produces a single-page client with `study`, `practice`, and `review` tabs.

- [ ] **Step 1: Write a failing build smoke test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { QUESTIONS } from './questionBank.js';

test('the initial study card is backed by a real question', () => {
  assert.equal(QUESTIONS[0].id, 'epg-01');
});
```

- [ ] **Step 2: Run the client test to verify it fails before UI setup**

Run: `cd interview-trainer && npm test -- src/App.test.js`

Expected: FAIL because `App.test.js` does not exist.

- [ ] **Step 3: Build the client**

Implement tab navigation, cue/short/full-answer reveal controls, mastered and practice-again controls, random question selection, text area, submit states, result panel, and weak-question filtering. Use `localStorage` behind defensive JSON parsing. Use responsive CSS that preserves a single-column flow on narrow screens.

- [ ] **Step 4: Run tests and production build**

Run: `cd interview-trainer && npm test && npm run build`

Expected: all tests PASS and Vite writes `dist/` successfully.

- [ ] **Step 5: Commit**

```bash
git add interview-trainer/src interview-trainer/vite.config.js
git commit -m "feat(trainer): add study and typed practice interface"
```

### Task 5: Document local start and validate complete application

**Files:**
- Create: `interview-trainer/README.md`

**Interfaces:**
- Documents `npm install`, copying `.env.example` to `.env`, configuration, and `npm run dev`.

- [ ] **Step 1: Write the setup documentation**

Include exact commands, explain that `LLM_MODEL` must match the provider, clarify that the server appends `/v1/chat/completions`, and tell the user not to commit `.env`.

- [ ] **Step 2: Verify all checks**

Run: `cd interview-trainer && npm test && npm run build`

Expected: all tests PASS and build succeeds.

- [ ] **Step 3: Commit**

```bash
git add interview-trainer/README.md
git commit -m "docs(trainer): add local setup guide"
```
