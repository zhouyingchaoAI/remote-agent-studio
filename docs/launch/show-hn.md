# Show HN 发布素材

## Title(80 字符内,任选其一)

Show HN: SSH-native desktop app for Codex/Claude Code – auto setup, 4 engines

Show HN: Run Codex and Claude Code on any remote box from a desktop GUI

## First comment(发帖后立刻自己补的第一条评论,决定讨论走向)

Hi HN! I built this because every agent GUI assumes the agent runs on your laptop — but my real work lives on a GPU box and a company intranet server.

Remote Agent Studio is an Electron app: you paste one SSH connection, and it handles the rest — detects the remote env, installs Node (rootless via nvm) and the agent CLIs, configures proxying (reverse tunnel through your local proxy, useful behind restrictive networks), syncs your local auth, and gives you a streaming chat UI with diff review, cost tracking, SFTP, and multi-tab terminals.

A few design choices worth discussing:

Each turn is one non-interactive streaming exec (`codex exec --json` / `claude -p --output-format stream-json`) with precise session resume, instead of PTY scraping — much more robust across CLI updates.

It supports four engines in the same conversation with automatic context handoff: Codex, Claude Code, DeepSeek (via its official Anthropic-compatible endpoint), and Chinese models (GLM/Kimi/Qwen) through xAI's open-source grok CLI custom-model config.

Security: SSH host-key TOFU verification, keys in a 600-permission env file (never plaintext config), OS keychain for local credentials, and an OS-level sandbox mode for agent commands.

MIT licensed, ~7k LOC, 95+ tests. Happy to answer anything about the SSH/proxy plumbing — that was the hard part.

## 回帖预案

"Why Electron?" → 需要 SFTP/终端/多窗口 + 三平台分发,Tauri 缺 ssh2 生态成熟度;主进程生产依赖只有 ssh2 一个,包体可控。
"Why not just tmux + ssh?" → 可以!但流式解析、diff 审阅、四引擎切换、代理自动化和认证下发是 tmux 给不了的;终端党我们也内置了多标签终端。
"How is this different from Happy/CloudCLI?" → 它们遥控**本机**的 CLI;我们把**远程机**当第一公民,负责把远程环境从零搭起来。
"Security of storing SSH creds?" → OS keychain via safeStorage;host fingerprint TOFU;欢迎审计,代码就 7k 行。

## 时间与纪律

周二至周四,美西早 8-10 点发。发布后 6 小时守在评论区,所有问题 30 分钟内回复;当天发现的 bug 当天出 patch。
