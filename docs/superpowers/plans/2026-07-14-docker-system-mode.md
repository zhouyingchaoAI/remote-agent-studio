# Docker System Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every behavior change.

**Goal:** Let a user explicitly enable Docker and host-level commands for one remote Codex conversation while keeping the safe workspace sandbox as the default.

**Architecture:** Persist `permissionMode: "workspace" | "system"` on conversations. Map legacy `autoApprove=true` to system mode, restart the current Agent session when mode changes, and use Codex's existing bypass flag only after a renderer confirmation.

**Tech Stack:** React, Zustand, Electron IPC, Codex CLI, Node test runner.

## Constraints

- Default mode is `workspace`.
- `system` mode uses `--dangerously-bypass-approvals-and-sandbox`.
- Enabling system mode requires an explicit confirmation and displays a persistent warning badge.
- Do not store sudo passwords, edit `/etc`, or modify remote Docker groups.
- Detect Docker socket/no-new-privileges errors and display an actionable hint.
- Preserve legacy conversations: `autoApprove=true` maps to `system`; false/missing maps to `workspace`.

### Task 1: Permission model and command behavior

- [ ] Write failing tests for legacy migration, safe default, and system-mode Codex flags.
- [ ] Run tests and confirm expected failures.
- [ ] Add `permissionMode` normalization in the store and AgentSession.
- [ ] Add `updateConversationPermission(convId, mode)` and restart through existing `agent:start` options.
- [ ] Detect `/var/run/docker.sock`, `operation not permitted`, and `no new privileges` in stderr/tool output and emit `permission_hint` only in workspace mode.
- [ ] Run focused tests until green.

### Task 2: UI and confirmation

- [ ] Write failing source/UI contract tests for the new toggle, confirmation copy, warning badge, and permission hint action.
- [ ] Add the new-conversation toggle with explicit risk copy.
- [ ] Add a current-conversation header control that confirms before enabling system mode and restarts the Agent session.
- [ ] Render a persistent `系统权限` badge and an actionable permission hint message.
- [ ] Run all tests and the production build.
