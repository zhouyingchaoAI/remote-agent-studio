# Persistent Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve terminal sessions and file transfers while switching tabs or hosts.

**Architecture:** Add a lazy, persistent workspace layer keyed by host and view. Keep visited components mounted and hide inactive layers; notify terminals when they become visible and isolate transfer progress by host.

**Tech Stack:** React 18, Zustand, xterm.js, Electron, Node.js test runner.

## Global Constraints

- Navigation must not unmount chat, file, or terminal views after their first visit.
- Views and asynchronous events must be isolated by `hostId`.
- Do not eagerly open terminals for hosts or views the user has not visited.

---

### Task 1: Persistent workspace regression tests

**Files:**
- Create: `test/persistent-workspaces.test.js`
- Inspect: `src/App.jsx`
- Inspect: `src/components/TerminalPanel.jsx`
- Inspect: `src/components/FilePanel.jsx`

**Interfaces:**
- Consumes: renderer source files.
- Produces: regression assertions for persistent layers, terminal activation, and host-filtered transfer progress.

- [ ] Write tests that require a visited-view registry, stable `hostId:view` keys, an `active` terminal prop, and host-filtered progress events.
- [ ] Run `node --test test/persistent-workspaces.test.js` and verify it fails against conditional unmounting.

### Task 2: Persistent workspace implementation

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/components/TerminalPanel.jsx`
- Modify: `src/components/FilePanel.jsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `activeHostId`, active tab, host connection status.
- Produces: `PersistentWorkspace({ hosts, activeHostId, activeView, statuses })` and `TerminalPanel({ hostId, active })`.

- [ ] Track visited `hostId:view` pairs and render each pair with a stable React key.
- [ ] Hide inactive layers with CSS without unmounting their child components.
- [ ] Refit and resize xterm whenever `active` becomes true.
- [ ] Ignore file progress events whose `hostId` does not match the panel.
- [ ] Run the focused regression test and verify it passes.

### Task 3: Verification and restart

**Files:**
- Build output: `dist/**`

**Interfaces:**
- Consumes: completed renderer changes.
- Produces: tested production assets and a restarted Electron process.

- [ ] Run `node --test test/*.test.js` and verify zero failures.
- [ ] Run `vite build --configLoader runner` and verify exit code 0.
- [ ] Restart the app through the desktop launcher and verify the Electron main, renderer, GPU, and network processes exist.
