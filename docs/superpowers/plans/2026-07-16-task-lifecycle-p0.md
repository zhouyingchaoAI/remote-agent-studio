# Task Lifecycle P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade persisted conversations into reviewable and recoverable development tasks while preserving the current SSH and CLI execution transport.

**Architecture:** Task records are separate from conversations and point to their `convId`. The renderer derives task status from explicit lifecycle actions; Electron persists task records atomically and continues forwarding raw agent events. Existing session IDs, queues, diffs, usage and artifacts are reused as delivery evidence.

**Tech Stack:** Electron IPC, React 18, Zustand, Node `node:test`.

## Global Constraints

- Keep the current `codex exec` / `claude -p` execution and session-resume model unchanged.
- Persist each task as an independent atomic JSON file under Electron `userData`.
- Do not permit an `accepted` task while its linked conversation is running.
- Add contract tests for persistence, state transitions, and rendered task actions.
- Verify every implementation commit with `npm run lint`, `npm test`, `npm run build`, and `git diff --check` before completion.

### Task 1: Task persistence and IPC

**Files:** modify `electron/store.js`, `electron/main.js`, `electron/preload.js`; create `test/tasks-store.test.js`.

- [ ] Add failing source-contract tests for `loadTasks`, `saveTasks`, atomic temporary-file replacement, and the narrow `tasks:list` / `tasks:save` IPC endpoints.
- [ ] Run `node --test test/tasks-store.test.js` and confirm it fails before implementation.
- [ ] Implement `loadTasks()` and `saveTasks(tasks)` using `userData/tasks/<safe-id>.json`, `<file>.tmp`, rename, malformed-record filtering, and deletion cleanup.
- [ ] Expose `window.api.tasks.list()` and `window.api.tasks.save(tasks)` through `contextBridge` only.
- [ ] Run `node --test test/tasks-store.test.js` and commit with `feat: persist development tasks`.

### Task 2: Renderer lifecycle state

**Files:** modify `src/store.js`, `src/App.jsx`; create `test/task-lifecycle-ui.test.js`.

- [ ] Add a failing contract test requiring `tasks`, `activeTaskByHost`, `createTask`, `updateTaskStatus`, `recordTaskDelivery`, `reviewTask`, and `loadTasks`.
- [ ] Run `node --test test/task-lifecycle-ui.test.js` and confirm it fails before implementation.
- [ ] Implement task states `draft`, `queued`, `running`, `needs_input`, `needs_approval`, `review_ready`, `accepted`, `changes_requested`, `failed`, and `archived`; persist all transitions through `window.api.tasks.save`.
- [ ] In the application agent-event subscription, map task-linked agent start, diff, image, usage, dangerous command, error, and done events into run/delivery evidence. Map done to `review_ready` and errors to `failed`.
- [ ] Run `node --test test/task-lifecycle-ui.test.js test/streaming-and-diff.test.js` and commit with `feat: add task lifecycle state`.

### Task 3: Task and delivery review UI

**Files:** create `src/components/TaskPanel.jsx`; modify `src/App.jsx`, `src/components/ChatPanel.jsx`, `src/styles.css`, `test/task-lifecycle-ui.test.js`.

- [ ] Add a failing test requiring a task list, status labels, delivery evidence, `Accept`, and `Request changes` UI actions.
- [ ] Run `node --test test/task-lifecycle-ui.test.js` and confirm it fails before implementation.
- [ ] Render a host-scoped `TaskPanel` with status groups and a detail card that shows diff, artifact count, usage, dangerous-operation count, review note, and linked conversation action.
- [ ] Add a chat-header action to create a task from the active conversation; beginning its next run transitions the linked task to `running`.
- [ ] Implement review controls so Accept sets `accepted`; Request changes sets `changes_requested`, persists a note, and focuses the linked conversation.
- [ ] Run `node --test test/task-lifecycle-ui.test.js` and commit with `feat: add task delivery review UI`.

### Task 4: Documentation and full P0 verification

**Files:** modify `README.md`, `docs/优化计划-对标商业软件.md`.

- [ ] Document task states, delivery evidence, review behavior, and session-resume boundaries in the README.
- [ ] Mark this task-closure work delivered in the optimization plan and retain approval-control work as the next P0 plan.
- [ ] Run `npm run lint && npm test && npm run build && git diff --check`.
- [ ] Commit documentation with `docs: document task lifecycle`.
