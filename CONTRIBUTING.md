# Contributing · 参与贡献

Thanks for your interest! 中文说明在英文之后。

## Dev setup

```bash
npm install
npm run dev     # vite + electron
npm test        # node:test (95+ cases)
npm run lint
```

PRs should pass `npm test` and `npm run lint`. Keep changes focused; one topic per PR.

## The easiest first PR: add a model provider (~10 lines)

Chinese/other LLM providers live in one registry: `electron/ssh/grokProviders.js` → `GROK_PROVIDERS`. To add one:

```js
minimax: {
  label: 'MiniMax',
  baseUrl: 'https://api.minimax.chat/v1',   // OpenAI-compatible endpoint
  envKey: 'MINIMAX_API_KEY',
  models: ['minimax-m2.5']
},
```

Then add the same entry to `GROK_PRESETS` in `src/components/SetupPanel.jsx` (GUI key input), add the spec to `MODEL_PRESETS.grok` in `src/components/ChatPanel.jsx`, and extend the test in `test/grok-agent.test.js`. That's the whole change — see the `provider` label on issues for requests.

Other welcome areas: i18n strings, light theme, docs, streaming-json event samples from real grok runs (fixtures for the parser).

## Code style

Plain JS (no TS yet), 2-space indent, Prettier enforced. Main-process code favors defensive parsing and silent-fail for optional features; never let an optional dependency crash startup. Chinese comments are fine — match the surrounding file.

## Security

Never write API keys into config files or shell rc files — keys go through `Installer.setEnvKey` (600-permission env file). If you find a vulnerability, please email the maintainer instead of opening a public issue.

---

## 中文速览

跑通:`npm install && npm run dev`;提交前过 `npm test` 与 `npm run lint`。

**最容易的第一个 PR:加一家模型厂商,约 10 行**——在 `electron/ssh/grokProviders.js` 的 `GROK_PROVIDERS` 加一段(label / baseUrl / envKey / models),同步 `SetupPanel.jsx` 的 `GROK_PRESETS`、`ChatPanel.jsx` 的 `MODEL_PRESETS.grok`,补一行测试即可。带 `provider` 标签的 issue 就是需求清单。

其它欢迎方向:i18n 文案、浅色主题、文档、grok 真实输出样本(解析器测试夹具)。安全问题请邮件联系维护者,不要发公开 issue。
