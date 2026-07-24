# Remote Agent Studio 🛰️

**给 Codex / Claude Code / 国产大模型加上"远程模式":填一条 SSH,剩下全自动。**

图形化 SSH 远程 AI 编程客户端:一键连上远程开发机(或本机),自动配置网络代理、安装 CLI、下发认证,然后在原生桌面界面里对话式使用 **Codex / Claude Code / DeepSeek / 国产模型(GLM · Kimi · 通义,经 grok CLI)**,流式输出、红绿 diff、文件与终端全都有。

[English](README.md) · 简体中文

<!-- 徽章:推送到 GitHub 后把 OWNER 替换为实际用户名 -->
[![CI](https://github.com/zhouyingchaoAI/remote-agent-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/zhouyingchaoAI/remote-agent-studio/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/zhouyingchaoAI/remote-agent-studio)](https://github.com/zhouyingchaoAI/remote-agent-studio/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

<!-- 演示 GIF:30 秒,从填 SSH 到 agent 流式改代码。分镜见 docs/发布指南.md -->
<!-- ![演示](docs/assets/demo.gif) -->

## 为什么做这个?

市面上所有 agent 图形客户端都默认 agent 跑在**本机**,再想办法让你从手机/网页够到它。但真实的活儿往往在别处:GPU 机器、公司内网服务器、云上 VM。Remote Agent Studio 把**远程开发机当第一公民**:SSH 连上即用,环境、代理、认证全自动;同时把国产大模型做成一等公民——DeepSeek 官方端点直驱 Claude Code,GLM/Kimi/通义经 grok CLI 自定义端点接入,全程图形化配置,不碰配置文件。

## 功能

### 对话
- **四引擎同对话切换** — Codex ↔ Claude Code ↔ DeepSeek ↔ 国产模型(Grok)随时切换,自动上下文接力(注入对话摘要),共用一份聊天记录
- **国产 DeepSeek V4** — 通过 DeepSeek 官方 Anthropic 兼容端点(api.deepseek.com/anthropic)驱动 Claude Code CLI 全流程;预设 `deepseek-v4-pro[1m]` / `deepseek-v4-flash`
- **国产模型统一引擎(Grok Build)** — 集成 xAI 开源的 [grok CLI](https://github.com/xai-org/grok-build) 作为国产大模型统一 harness:DeepSeek / 智谱 GLM / Kimi / 通义 Qwen 经各家 OpenAI 兼容端点接入;端点、模型名、协议、密钥全部图形化配置(含中转站自定义端点),`~/.grok/config.toml` 受管块自动生成,API Key 走 env_key 不落明文
- **流式输出** — token 级增量渲染;思考过程、命令执行、文件修改(红绿 diff)、成本统计都有独立气泡
- **模型可切换** — 预设 + 自定义模型名,对话中途切换立即生效,上下文保留
- **排队发送** — 执行中继续发消息自动排队,逐条执行;可移出队列
- **全自动模式** — 模型请求确认时自动回复继续(连续 5 次熔断防失控)
- **选项/确认按钮** — "1. xxx / 2. xxx"式选项和"请确认"类提问自动生成可点击按钮
- **Markdown 渲染** — 聊天气泡与 .md 文件预览均为阅读模式;消息里的文件路径可点击直接预览
- **截图/附件** — ⌘V 直接粘贴截图(带缩略图预览),附件上传后 codex 以 `--image` 真正看图
- **搜索与导出** — 会话全文搜索;一键导出对话为 Markdown
- **用量统计** — 对话头部实时累计 token 与费用
- **多轮续聊** — codex 按会话 ID 精确 resume,claude 按 session 续聊,grok 按 `-s/--resume` UUID 续聊,跨重启不丢

### 连接与环境
- **主机管理** — 多台 SSH 主机(密码/私钥),凭据经系统钥匙串加密存储
- **主机指纹校验(TOFU)** — 首次记录指纹,变更时强制人工确认,防中间人攻击
- **断线自动重连** — 指数退避重连并自动重建反向隧道
- **自动配置网络代理** — SSH 反向隧道 / 局域网代理直连两种模式,连接后自动应用与连通性测试
- **一键安装/升级** — 远程缺 Node 走 nvm 免 root 安装;codex 优先官方独立二进制(直连失败自动走代理断点续传,SHA-256 校验);grok 走官方安装脚本;本机走 npm
- **认证下发** — 本机 `~/.codex/auth.json` 一键复制到远程免登录;API Key 存 600 权限独立文件,不落 bashrc 明文
- **本地模式** — 无需 SSH 直接在本机运行,环境与你的终端完全同源(交互式登录 shell 环境抓取)

### 文件与终端
- **文件树 + 双栏 SFTP** — 侧边栏文件树默认打开项目目录;点击文件直接预览(文本/图片/Markdown 阅读模式)
- **可视化传输** — 拖拽上传、进度条、失败重试、远程建目录/删除
- **多标签终端** — 每个标签独立 shell,自动加载代理与 agent 环境,可跑 `codex login` 等交互命令

### 可靠性
- 主进程崩溃日志落盘(`userData/logs/`),环境配置页一键导出诊断信息
- 对话历史按会话分文件持久化,原子写入,崩溃不丢
- GitHub Actions CI(Ubuntu + macOS 测试与构建),95+ 单元测试

## 快速开始

从 [Releases](https://github.com/zhouyingchaoAI/remote-agent-studio/releases) 下载 macOS / Windows / Linux 安装包,或源码运行:

```bash
npm install
npm run dev      # 开发模式(vite + electron)
npm run start    # 构建后运行
npm run dist     # 打包安装包(dmg/nsis/AppImage)
npm test         # 单元测试
```

macOS 也可直接双击 `启动.command`(会自动检测并修复从其他平台拷贝的 node_modules)。

## 使用流程

1. **添加主机** → 填 IP/端口/用户名 + 密码或私钥 → 保存并连接(或直接用「本地(本机)」)
2. **环境配置页** → 按需应用代理 → 一键安装/升级 Codex / Claude Code / Grok CLI → 下发认证或写入 API Key(国产模型端点在此图形化配置)
3. **对话页** → 选引擎、选工作目录 → 开始对话;可随时切换引擎/模型、开全自动
4. **文件页 / 终端页** → 传文件、跑交互命令

国产模型详细配置(DeepSeek / GLM / Kimi / 通义 / 中转站)见 [国产模型接入指南](docs/国产模型接入指南.md);常见问题见 [FAQ](docs/FAQ.md)。

## 架构

```
electron/
  main.js            IPC 路由、窗口、指纹校验、文件预览、诊断导出
  preload.js         contextBridge 安全暴露 API
  store.js           主机/对话/代理/指纹持久化(safeStorage 加密)
  logger.js          主进程日志与异常兜底
  LocalExecutor.js   本地模式执行器(终端同源环境解析)
  chat/              附件与生成图片回收(路径安全校验)
  ssh/
    SSHManager.js    ssh2 连接 / exec / 多 shell / SFTP / 反向隧道 / 自动重连
    ProxyService.js  代理配置(隧道 + 环境变量 + 连通性测试)
    Installer.js     远程环境检测、CLI 安装/升级、grok config 受管块
    AgentSession.js  codex/claude/grok 流式 JSON 事件 → 统一聊天消息
    deepseek.js      DeepSeek Anthropic 兼容端点注入
    grokProviders.js 国产模型 provider 注册表 + grok 受管配置生成
src/                 React 界面(zustand 状态)
test/                node:test 单元测试(95+ 用例)
docs/                文档(国产模型指南 / FAQ / 发布指南 / 策略)
```

每轮对话 = 一次非交互流式执行(`codex exec --json` / `claude -p stream-json` / `grok -p streaming-json`)+ 精确会话 resume,不依赖脆弱的 PTY 抓屏。

## 安全说明

- 「系统权限 / System Mode」会让 agent 绕过沙箱在远程任意执行命令,仅在可信环境使用
- 全自动模式会替你确认模型的继续请求,连续 5 次后自动暂停,请留意其执行内容
- 主机指纹变更告警出现时,请先向服务器管理员核实,再决定是否信任
- API Key 存远程 600 权限 env 文件(不落 bashrc/配置明文);本机凭据走系统钥匙串

## 参与贡献

欢迎 PR——新增一家模型厂商只需约 10 行代码,见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)
