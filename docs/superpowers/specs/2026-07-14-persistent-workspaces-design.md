# Persistent Workspaces Design

## Goal

Keep chat, file-transfer, and terminal views alive independently when the user switches tabs or hosts.

## Design

The renderer keeps every visited remote-host view mounted for the lifetime of the main workspace. Switching a tab or host changes only the active CSS layer. Views are mounted lazily, so opening one host does not create terminal sessions or file requests for unrelated hosts.

Each mounted view is keyed by both `hostId` and view name. File transfer progress handlers filter events by `hostId`; this prevents progress from another host from affecting the current task. The terminal receives an `active` flag and fits/resizes itself after becoming visible.

Disconnected hosts continue to show the existing connection gate. Explicit disconnection may end remote operations, but navigation alone never unmounts a view or closes its terminal.

## Verification

- A source-level regression test proves visited views are rendered as persistent keyed layers instead of mutually exclusive conditional branches.
- A terminal regression test proves cleanup is tied to workspace lifetime and visibility triggers refitting.
- A file-transfer regression test proves progress events are isolated by host.
- The complete test suite and production build must pass before restart.
