# Remote Agent Studio 🛰️

### 🌐 **[English](README.md)** · **[📖 中文说明 / Chinese Docs →](README.zh-CN.md)**

> 🇨🇳 **中文用户看这里** → 完整中文文档见 **[README.zh-CN.md](README.zh-CN.md)**;国产模型(DeepSeek / GLM / Kimi / 通义)接入指南见 **[docs/国产模型接入指南.md](docs/国产模型接入指南.md)**,常见问题见 **[docs/FAQ.md](docs/FAQ.md)**。

**Your AI coding agents, on any machine.** One-click SSH to a remote dev box, automatic environment setup, and a native desktop chat UI for **Codex, Claude Code, DeepSeek, and Chinese LLMs (GLM / Kimi / Qwen via grok CLI)** — with streaming output, diff review, and full file/terminal access.

<!-- Badges: replace OWNER/REPO after pushing to GitHub -->
[![CI](https://github.com/zhouyingchaoAI/remote-agent-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/zhouyingchaoAI/remote-agent-studio/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/zhouyingchaoAI/remote-agent-studio)](https://github.com/zhouyingchaoAI/remote-agent-studio/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)

<!-- DEMO GIF: 30s, from "paste SSH info" to "agent streams a code edit". See docs/发布指南.md for the storyboard. -->
<!-- ![Demo](docs/assets/demo.gif) -->

## Why Remote Agent Studio?

Every other agent GUI assumes your agent runs on *this* machine. Real work often lives elsewhere: a GPU box, a company intranet server, a cloud VM. Remote Agent Studio makes the **remote machine a first-class citizen**:

- **One SSH entry → working agent.** Auto-detects the remote environment, installs Node.js (rootless via nvm) and the agent CLIs, configures network proxying (reverse tunnel or LAN direct), and syncs your local auth — no manual setup on the box.
- **Four engines, one conversation.** Switch between Codex ↔ Claude Code ↔ DeepSeek ↔ Chinese models (grok CLI) mid-conversation; context is handed off automatically via injected summaries.
- **First-class Chinese LLM support.** DeepSeek V4 via its official Anthropic-compatible endpoint; GLM / Kimi / Qwen / any OpenAI-compatible relay via [grok CLI](https://github.com/xai-org/grok-build) custom models — all configured from the GUI, keys stored in a 600-permission env file, never in plaintext config.
- **Desktop-grade UX.** Token-level streaming, reasoning bubbles, red/green diffs, cost tracking, message queueing, auto-approve with a circuit breaker, clickable option buttons, screenshot paste, full-text search, Markdown export.
- **Trustworthy plumbing.** SSH host-key verification (TOFU), auto-reconnect with backoff, precise session resume across restarts, crash logs, atomic conversation persistence.

## Features

| Area | What you get |
|---|---|
| Chat | 4 engines with mid-conversation switching & context handoff, streaming output, thinking/tool/diff/cost bubbles, queued sends, auto-confirm (5-strike breaker), option buttons, attachments with image support, search & Markdown export |
| Voice & capture | Voice input (mic → cloud STT via OpenAI-compatible `/audio/transcriptions`), voice confirmation (say "confirm / cancel" or an option to trigger the button), global-hotkey region screenshot auto-attached to the chat |
| Engines | Codex CLI, Claude Code CLI, DeepSeek (Anthropic-compatible endpoint), grok CLI with GUI-managed custom endpoints for GLM / Kimi / Qwen / DeepSeek / relays |
| Connection | Multi-host SSH (password/key, credentials in OS keychain), host fingerprint TOFU, auto-reconnect, reverse-tunnel or LAN proxy auto-config with connectivity tests, local mode (no SSH, shell-identical env) |
| Setup | One-click install/upgrade of all CLIs (rootless Node via nvm; official standalone binaries with proxy fallback + SHA-256 verify), local auth sync to remote, API key management |
| Files & Terminal | File tree + dual-pane SFTP, drag-and-drop transfers with progress/retry, text/image/Markdown preview, multi-tab terminals with agent env preloaded |
| Reliability | Crash logs to disk, one-click diagnostics export, per-conversation atomic persistence, CI on Ubuntu + macOS, 95+ unit tests |

## Quick Start

**Download** the latest release for macOS / Windows / Linux from [Releases](https://github.com/zhouyingchaoAI/remote-agent-studio/releases), or run from source:

```bash
git clone https://github.com/zhouyingchaoAI/remote-agent-studio.git
cd remote-agent-studio
npm install
npm run dev        # development (vite + electron)
npm run dist       # package installers (dmg / nsis / AppImage)
```

Then, in the app:

1. **Add a host** — IP / port / user + password or private key. Or pick **Local** to run on this machine with your exact shell environment.
2. **Setup page** — apply proxy config if needed → one-click install Codex / Claude Code / grok CLI → sync auth or paste API keys.
3. **Chat** — pick an engine and a working directory, and start talking. Switch engine or model anytime.
4. **Files / Terminal** — transfer files, run interactive commands.

Using DeepSeek or other Chinese models? See the [Chinese LLM setup guide](docs/国产模型接入指南.md) (English summary inside).

## Architecture

```
electron/
  main.js            IPC routing, windows, fingerprint checks, previews, diagnostics
  preload.js         contextBridge API surface
  store.js           hosts / conversations / proxies / fingerprints (safeStorage-encrypted)
  LocalExecutor.js   local mode executor (login-shell env capture)
  chat/              attachment & generated-image handling (path-safety checks)
  ssh/
    SSHManager.js    ssh2 connect / exec / shells / SFTP / reverse tunnel / reconnect
    ProxyService.js  proxy config (tunnel + env + connectivity tests)
    Installer.js     remote env detection, CLI install/upgrade, grok config management
    AgentSession.js  codex / claude / grok stream-JSON events → unified chat messages
    deepseek.js      DeepSeek Anthropic-compatible endpoint injection
    grokProviders.js Chinese LLM provider registry + managed grok config generation
src/                 React UI (zustand state)
test/                node:test suites (95+ cases)
```

Each conversation turn is one non-interactive streaming exec (`codex exec --json` / `claude -p --output-format stream-json` / `grok -p --output-format streaming-json`) with precise session resume — no fragile PTY scraping.

## Security Notes

- **System Mode** lets the agent bypass sandboxing on the remote host. Use only in trusted environments.
- Auto-confirm replies to the model's continue-prompts for you; it pauses after 5 consecutive confirmations. Watch what it does.
- On a host fingerprint change alert, verify with your server admin before trusting.
- API keys are stored in a 600-permission env file on the remote (never in shell rc files or config plaintext); local credentials use the OS keychain.

## Contributing

PRs welcome — adding a model provider is a ~10-line change. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
