# Multi-Agent Templates and Review Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn task templates into auditable research, implementation, and review stages with isolated working directories and a consolidated review inbox.

**Architecture:** Persist a template definition and its stage records on each task. A stage creates a separate conversation with an explicit cwd; for git projects the main process creates a named worktree before its implementation/review stage starts. The task view becomes the inbox for tasks requiring a human decision, without inventing agent parallelism when the host cannot create worktrees.

**Tech Stack:** Electron IPC, ssh2/local executor, React, Zustand, node:test.

## Global Constraints

- Preserve existing task delivery, audit, approval, retry and acceptance records.
- Never create or remove a worktree without an explicit user action from a selected template stage.
- All remote shell arguments must use existing SSH quoting helpers.
- A worktree setup failure must leave the task in `needs_input` with an audit event; it must not silently use the base cwd.
- Tests must cover the renderer/store contract and the narrow IPC contract before implementation.

---

### Task 1: Persisted task templates and stage lifecycle

**Files:**
- Modify: `src/store.js`
- Modify: `src/components/ChatPanel.jsx`
- Test: `test/task-templates.test.js`

- [ ] **Step 1: Write failing contract tests** for `TASK_TEMPLATES`, `createTask(..., { templateId })`, and `startTaskStage(taskId, stageId, fields)`.
- [ ] **Step 2: Run** `node --test test/task-templates.test.js` and confirm failure.
- [ ] **Step 3: Implement** three templates (`research`, `implementation`, `review`) and persist each task's immutable stage records with role, status, cwd and conversation id.
- [ ] **Step 4: Add Chat task creation UI** that lets a user select a template before creating a task, defaulting to `implementation`.
- [ ] **Step 5: Run** `node --test test/task-templates.test.js` and commit `feat: add task templates and stages`.

### Task 2: Explicit isolated worktree provisioning

**Files:**
- Modify: `electron/main.js`
- Modify: `electron/preload.js`
- Create: `electron/git/WorktreeService.js`
- Modify: `src/components/TaskPanel.jsx`
- Test: `test/worktree-ipc-contract.test.js`

- [ ] **Step 1: Write failing contract tests** for `worktrees:create` and a service that accepts `{hostId, baseCwd, taskId, stageId}` and returns `{cwd, branch}`.
- [ ] **Step 2: Run** `node --test test/worktree-ipc-contract.test.js` and confirm failure.
- [ ] **Step 3: Implement** a narrow service that runs `git worktree add -b ras/<taskId>-<stageId> <baseCwd>/.ras-worktrees/<taskId>-<stageId>` through the existing local/SSH execution paths and returns the resulting cwd.
- [ ] **Step 4: Add** an explicit “prepare isolated worktree” action in the stage card; record success/failure into task audit and never fall back to the base cwd.
- [ ] **Step 5: Run** `node --test test/worktree-ipc-contract.test.js` and commit `feat: provision isolated task worktrees`.

### Task 3: Review Inbox and stage handoff

**Files:**
- Modify: `src/components/TaskPanel.jsx`
- Modify: `src/styles.css`
- Test: `test/review-inbox.test.js`
- Modify: `docs/优化计划-对标商业软件.md`

- [ ] **Step 1: Write failing tests** for an inbox that lists `needs_approval`, `review_ready`, and review stages awaiting a decision.
- [ ] **Step 2: Run** `node --test test/review-inbox.test.js` and confirm failure.
- [ ] **Step 3: Implement** the Inbox filter, decision counts, and a stage handoff action that opens the exact stage conversation/cwd.
- [ ] **Step 4: Add compact styles** for stage status and worktree metadata.
- [ ] **Step 5: Run** `npm test && npm run lint && npm run build`, update the delivery plan, and commit `feat: add review inbox for staged tasks`.
