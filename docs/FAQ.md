# FAQ · 常见问题

> Bilingual: 中文在前,English below.

## 连接与代理

**连不上主机 / Connection refused。** 先用系统终端 `ssh user@host -p 端口` 验证连通;通了但应用连不上,多半是私钥格式(应用支持 OpenSSH 格式,PuTTY 的 .ppk 需先转换)或密码含特殊字符,查看侧边栏状态提示与「环境配置」页日志。

**主机指纹变更告警。** 这是防中间人攻击的 TOFU 校验。服务器重装/换机后指纹会变,向管理员核实后再点信任;不明原因的变更不要点。

**远程机访问不了 OpenAI/Anthropic。** 「环境配置」页选代理模式:本机有代理(如 Clash 7890 端口)选「SSH 反向隧道」,远程流量经隧道走你本机代理;远程与本机同局域网可选「局域网直连」。点「应用代理配置并测试」看连通性结果。国产模型端点(DeepSeek/GLM/Kimi/通义)国内服务器一般直连即可,无需代理。

**断线后会怎样。** 自动指数退避重连并重建反向隧道;正在执行的那一轮会中断,已产生的消息不丢,重连后可继续发。

**终端能用,但对话一直报 "Channel open failure / SSH 通道已用尽"。** 远程 sshd 的 `MaxSessions`(默认 10)被占满了:终端标签、SFTP、后台任务各占一个通道,而对话每轮要新开一个 exec 通道。终端是已建好的长连接所以不受影响。处理:先关掉多余的「终端」标签(应用会自动回收 SFTP 通道并重试);仍不够就在远程 `/etc/ssh/sshd_config` 里调大 `MaxSessions`(如 `MaxSessions 50`),然后 `sudo systemctl reload sshd`。

## 安装与认证

**一键安装失败。** 看「环境配置」页日志:缺 Node 会自动走 nvm 免 root 安装(慢,耐心);下载超时通常是网络问题,先把代理配好再重试;老系统(glibc < 2.28)会自动换兼容版 Node。

**Codex 认证下发后仍提示未登录。** 确认本机 `~/.codex/auth.json` 存在且本机 codex 可用;ChatGPT 登录态有有效期,过期需本机重新 `codex login` 再下发。

**Claude 认证下发不了 / 我是 Pro 会员想在远程用。** 可以。macOS 上 Claude Code 的登录态存在**钥匙串**(条目 `Claude Code-credentials`)而不是文件里,所以早期版本找不到。现在点「下发 Claude 认证」会自动从钥匙串导出并写成远程的 `~/.claude/.credentials.json`(600 权限)——Claude Code 支持这个文件回退,订阅登录态因此能在远程机上直接用,不必额外买 API Key。

首次导出若弹出钥匙串授权,点「允许」。如果提示找不到凭据,先在本机终端跑一次 `claude` 确认处于登录状态。

**远程报 "OAuth session expired and could not be refreshed"。** 订阅登录的 token 有有效期,过期后远程无法自行刷新。处理:在本机运行一次 `claude` 确认仍是登录态,回到「环境配置」页重新点一次「下发 Claude 认证」即可。下发时日志会显示 token 的到期时间,方便你预判。

**API Key 存在哪,安全吗。** 远程 `~/.remote-agent-env.sh`,600 权限,不写入 bashrc 明文,配置文件里只引用变量名;本机主机凭据经系统钥匙串加密。

## 对话与引擎

**长任务跑到一半报 "Connection closed mid-response" / 经常中断。** 这是代理或网络对**长连接**超时,不是模型的问题:Claude/Codex 用 SSE 流式响应,一次回合可能持续好几分钟(截图里那次 277 秒),代理只要有空闲超时或总时长上限就会把连接切断。

应用现在会自动处理:识别到这类**瞬时**中断后,利用保留的会话 ID 自动 resume 续跑(最多 3 次,指数退避 2→4→8 秒),并在对话里显示 `🔌 响应中途连接被断开,N 秒后自动续跑`。续跑提示词会要求模型先检查实际进度、从中断处继续、不重复已完成的改动。认证类错误(如 OAuth 过期)不会重试——那种重试只是白烧钱。

要根治,调大代理侧的超时:
- **Clash / Clash.Meta**:相关超时通常在几分钟量级,长任务建议适当放宽;若走的是自建 nginx 中转,见下条
- **nginx 反代**:`proxy_read_timeout 3600s; proxy_send_timeout 3600s; proxy_buffering off;`(`proxy_buffering off` 对 SSE 很关键)
- 也可以把大任务拆小,单轮控制在 1-2 分钟内

**输出中途停了 / 进程退出码非 0。** 错误气泡会带最近输出;常见原因依次是:认证失效(重新下发/写 key)、代理断了(重新应用代理)、模型名不存在(换预设或自定义正确的名字)。

**切换引擎后上下文还在吗。** 在。切换后首条消息自动携带对话摘要接力;目标引擎会开新的 CLI 会话。

**全自动模式安全吗。** 它只自动回复"继续/确认",连续 5 次自动暂停熔断;危险命令在气泡上有红色标识。生产环境慎开,搭配 workspace 权限使用。

**System Mode 和 workspace 的区别。** workspace 限制写入工作目录(codex 沙箱 / claude acceptEdits / grok OS 级沙箱);System Mode 全放开,能碰 Docker 和系统文件,仅在可信环境用。

**国产模型接入问题。** 见[国产模型接入指南](国产模型接入指南.md)。

## 语音与截图

**语音输入没反应 / 提示未配置。** 到设置 → 语音输入,填 STT 端点(OpenAI `https://api.openai.com/v1`、通义 DashScope 兼容端点或中转站)、转写模型(如 `gpt-4o-mini-transcribe`、`whisper-1`)和 API Key,点「测试」通过后再用。首次点麦克风会请求系统麦克风权限,需允许。

**语音确认怎么用。** 模型弹出确认或选项卡片时,卡片上有「🎤 语音」按钮:说「确认/继续」或「取消/停止」命中对应按钮;选项卡片可说序号(「第 2 个」「二」)或选项名称。同时说了确认和取消时按取消处理(更安全)。听不懂会提示原文,可重说。

**快捷键截图。** 默认全局快捷键 ⌘/Ctrl+Shift+2(设置里可改或关闭),触发系统区域截图,截完自动作为附件进当前对话;输入区也有「✂ 截图」按钮。macOS 走 `screencapture`,Linux 走 gnome-screenshot/maim 等,Windows 走系统截图工具 + 剪贴板。若快捷键无效,多为被其它软件占用,换一个组合即可。

## 其它

**日志和诊断在哪。** 主进程崩溃日志在 `userData/logs/`;「环境配置」页右侧是实时日志,可一键「导出诊断」(已脱敏)。

**对话历史存在哪。** 本机 userData 下按会话分文件、原子写入;删除对话会同时清理远程附件目录。

---

## English

**Can't connect:** verify with plain `ssh` first; check key format (OpenSSH, not .ppk) and the Setup-page log. **Fingerprint change alert:** TOFU protection — confirm with your server admin before trusting. **Remote box can't reach OpenAI/Anthropic:** apply a proxy in Setup (reverse tunnel through your local proxy, or LAN direct); Chinese model endpoints usually need no proxy from mainland servers. **Install fails:** read the Setup log — Node is auto-installed rootless via nvm; configure the proxy before retrying downloads. **Claude auth won't sync on macOS:** credentials live in the Keychain; use an `ANTHROPIC_API_KEY` or run `claude` login in the Terminal tab. **Where are keys stored:** a 600-permission env file on the remote, never in rc files; local credentials use the OS keychain. **Engine switching:** context is handed off via an injected summary; the target engine starts a fresh CLI session. **System Mode vs workspace:** workspace confines writes to the project dir (codex sandbox / claude acceptEdits / grok OS sandbox); System Mode removes confinement — trusted environments only. **Diagnostics:** crash logs under `userData/logs/`; one-click sanitized diagnostics export on the Setup page.

## 团队模式(两个引擎协作)

一个引擎干活、另一个审查,配合目标模式跨轮自动推进。

```
/team claude+codex      # Claude 干活,Codex 审查
/goal 把登录接口补上限流并加测试
```

之后每轮:执行方做 → 审查方读改动、跑测试、挑问题 → 有问题打回返工,
通过则交给目标模式做达成核验。状态条会显示当前谁在干活、审查了几次。

`/team status` 看状态,`/team off` 关闭。

**为什么是「干活 + 审查」而不是轮流接力**:两个引擎交替改同一堆文件极容易
互相覆盖、反复推翻。职责分开后执行方只管做、审查方只管挑,谁也不会去改
对方刚写的东西 —— 「是否真的完成」也才有第二双眼睛。

**成本**:每轮审查同样烧 token,总成本大约是单引擎的两倍。轮次预算沿用
目标模式(`/goal max N` 调整),审查方连续 3 次打回仍未通过会自动暂停。

**已知边界**:审查方必须以「审查通过」或「审查不通过」作结;没给判定词时
一律按未通过处理 —— 把含糊结论当作通过,等于审查形同虚设。

## 异常日志

顶栏「🩺 异常日志」页。对话报错、引擎崩溃、SSH 断连、传输失败、主进程与
渲染进程的未捕获异常都会自动进来,不需要手动开启。

**默认按指纹聚合而不是流水**:同一个 bug 会产出几十条只有路径和行号不同的
记录,「这个错出了 27 次、最近一次 3 分钟前」才是能拿来排修复优先级的信息。
点开某一类可以看到原始上下文、涉及的主机与来源。

分类里 **代码崩溃(crash)** 是唯一必须改代码的,其余(认证/网络/额度/未安装)
多半改配置就能解决,所以 crash 优先级判定排在最前,不会被别的规则蹭走。

**内容在写入时就已脱敏** —— API key、Bearer token、URL 里的账号密码、私钥
整段都会被抹掉(保留 `sk-fOc2***` 这样的前缀便于分辨是哪一把)。所以「导出」
和单条「复制」出来的内容可以直接贴 issue。

日志文件在应用数据目录的 `error-log.jsonl`,超过 4MB 自动滚存一代。

## GitHub 快捷登录

「环境配置」页的 **GitHub** 卡片,本机与每台远程主机各自独立登录。

点「登录 GitHub」后,应用里会显示一个大号一次性码和一个**已经填好码**的
授权链接。在手机上打开那个链接会直接唤起 GitHub App,点一下确认即可;
确认后应用自动完成剩下的步骤,不用回来点任何按钮。登录成功会顺带配好
git 凭据助手,https 方式的 `git push/pull` 直接免密。

**token 不经过本应用**:登录走主机上 gh 自己的设备流,凭据由 gh 保管在它
自己的位置,我们只读 stdout 拿那个一次性码。所以 token 不会出现在界面、
IPC、日志或异常日志里。

**为什么在对话里让 agent 跑 `gh auth login` 会卡住**:那是在有 tty 的终端里
执行,gh 判定为交互模式,会停在「Press Enter to open ... in your browser」
等一个永远不会来的回车。应用这边把 stdin 断开,gh 转为非交互,直接打码并
开始轮询,所以不会卡。

**每台主机各自独立**:卡片标题会写明当前是「本机」还是哪台远程主机。
本机登录后,到各远程主机点「从本机下发」即可复制过去,不必每台都扫一次码;
也可以在远程直接走设备流,两种方式等价。

下发时 token 会短暂经过主进程,所以约束更严:走 stdin 送到远端(不拼进
命令行 —— `ps` 对同机其他进程可见),不落日志、不进返回值、不给界面。

远程主机没装 gh 时,卡片上的「安装 gh」会把官方 tarball 装到
`~/.local/bin`(不需要 root,ARM 机器也支持)。macOS 本机只给出
`brew install gh` 的建议而不代劳 —— brew 会改动全局环境,不该替你决定。
