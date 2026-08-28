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

**对话页也能登**:顶栏引擎徽标旁边有个 GitHub 徽标,显示当前主机的登录
身份,点开就是同一张卡片 —— 要 push 的时候不用切去环境配置。也可以用
`/github status | login | sync`;从聊天里发起登录时,一次性码会直接贴回对话。

**每台主机各自独立**:卡片标题会写明当前是「本机」还是哪台远程主机。
本机登录后,到各远程主机点「从本机下发」即可复制过去,不必每台都扫一次码;
也可以在远程直接走设备流,两种方式等价。

下发时 token 会短暂经过主进程,所以约束更严:走 stdin 送到远端(不拼进
命令行 —— `ps` 对同机其他进程可见),不落日志、不进返回值、不给界面。

远程主机没装 gh 时,卡片上的「安装 gh」会把官方 tarball 装到
`~/.local/bin`(不需要 root,ARM 机器也支持)。macOS 本机只给出
`brew install gh` 的建议而不代劳 —— brew 会改动全局环境,不该替你决定。

## 镜像仓库登录(Harbor / Docker Hub)

「环境配置」页的 **镜像仓库** 卡片。地址留空即 Docker Hub,Harbor 填
`harbor.example.com`(带端口、带项目路径都行)。Harbor 的机器人账号名字形如
`robot$ci`,直接填即可。

**密码走 stdin 直达 docker**(`--password-stdin`),不拼进命令行 —— 命令行在
`ps` 里对同机所有进程可见,还会进 shell history。docker 自己也会为 `-p` 打警告。

**勾了「记住」才会保存**,用系统钥匙串加密存在本机。**系统加密不可用时会
明确拒绝保存**,不会退回明文 base64:base64 不是加密,而用户会以为它是 ——
一个存密码的功能悄悄降级,比不提供这个功能更糟。此时仍可每次手动输入登录。

保存后可以「登录到所有主机」,一次把本机与全部远程主机都登上。

**登录卡住不动?先点「诊断网络」。** 最常见的原因是 **docker 守护进程没配代理**:
`docker login` 的网络请求不是 CLI 发的,而是 docker 守护进程发的,守护进程
**不读你 shell 里的 `https_proxy`**。所以在终端里 `curl https://harbor.example.com/v2/`
一切正常(返回 401 是 registry 未认证时的正常应答),`docker login` 却连不出去。

**反过来的情况同样常见**:守护进程配了外网代理,而仓库是内网地址
(`172.16.x`/`10.x`/`192.168.x`)。内网请求被发去外网代理,正好连不上 ——
这时要做的是把它加进守护进程的 **NO_PROXY**,而不是加代理。诊断会识别出
这一条并给出合并后的 NO_PROXY 配置。

**HTTP 仓库**:诊断会 https 与 http 各试一次。只写死 https 的话,
`http://ip:port` 这种自建仓库会被报成"连不上",而它其实好好的。若 http 通
而 https 不通,会主动提示必须先声明 `insecure-registries` —— 否则你会看到
"网络正常"然后登录照样失败。

缺代理时的配置命令:

```
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf <<EOF
[Service]
Environment="HTTP_PROXY=http://你的代理:端口"
Environment="HTTPS_PROXY=http://你的代理:端口"
Environment="NO_PROXY=localhost,127.0.0.1,::1"
EOF
sudo systemctl daemon-reload
sudo systemctl restart docker      # 会掐掉这台机器上所有正在运行的容器
```

如果仓库在内网可直连,给主机加一条路由/DNS 也行,不必让守护进程走代理。

**Harbor 自签证书 / HTTP 仓库**是另一个常见失败原因。登录失败时会识别出来并
给出两条处置命令:装 CA 证书到 `/etc/docker/certs.d/<host>/ca.crt`(推荐,
不降低安全级别、也不用重启 docker),或把它写进 `daemon.json` 的
`insecure-registries`。**应用不代改** —— 那是主机级安全配置,而且改完要重启
docker,重启会掐掉那台机器上所有正在运行的容器,不该由一个登录按钮顺手做掉。

界面上已登录列表只显示仓库地址与用户名。`~/.docker/config.json` 里的 `auth`
是 base64 的 `user:pass`,应用只取冒号前的用户名,密码到此为止不再传递。

## 远程 → 远程传输

「文件」页左栏顶部现在是一个主机下拉:默认「本机」,选成另一台远程主机后
两栏就都是远程,中间的箭头即在两台远程主机之间传。

**优先直连**:先探测源主机能不能直接 ssh 到目标(需要源主机上有到目标的
免密密钥且网络可达)。能直连就让源主机自己 `scp` 过去,数据完全不经过本机,
大文件快很多。传完会标注「完成(源主机直连)」。

**否则经本机中转**:源 → 本机临时目录 → 目标。一定能用(两台机器之间不需要
互通),但流量走两遍、占本机磁盘。进度分成「中转 1/2 下载」「中转 2/2 上传」
两段显示,并会说明这次为什么没能直连(多为源主机没有到目标的免密密钥)。

**走了中转怎么办**:传输条上会写明「直连不可用:xxx」。如果原因是
「源主机没有到目标主机的免密密钥」,旁边会出现「配置直连」按钮 ——
点它会在源主机生成 SSH 密钥(已有则不动)并把公钥写进目标主机的
`~/.ssh/authorized_keys`,配完立刻验证一次。之后再传就走直连了。

这是一次真实的授权变更(给目标主机加了一把可免密登录的钥匙),所以只在
你明确点击并确认后执行,绝不会在传输失败时自动做掉。网络不通、host key
变更这两种原因加公钥也解决不了,所以不会给按钮。

**直连的进度是估算的**:`scp` 只在 stdout 是终端时才打进度条,非交互执行
拿不到任何进度。所以应用自己造:传输前先量一次源路径总量,传输中每 3 秒
查一次目标路径已有多大。数字会滞后(scp 是按文件写完才增长),所以界面上
标注了「估算」—— 但至少是真在动、方向也对,比对着一个不动的 0 B 干等强。

**中转期间配好了直连**:当前这次仍走中转(开始时就选定了,不会中途切换),
提示里会写明,并给一个「用直连重传」按钮 —— 大目录走中转不值得等完。

**为什么必须先探测而不是直接试**:`scp` 在没有密钥时会卡在密码提示上等输入,
而我们是非交互执行 —— 那就是一次无限期挂起,界面表现为永远转圈。所以所有
ssh/scp 调用都带 `BatchMode=yes`,没密钥就立刻失败而不是提问。

host key 用 `accept-new`:首次连接自动接受,但已知 key 被换掉时仍然拒绝
(`StrictHostKeyChecking=no` 连"key 被换了"都照连不误,那是中间人的入口)。

## 终端里快速问一下(⌘K)

「终端」页右下角有个「💬 问一下」,或直接按 **⌘K**(Windows/Linux 是 Ctrl+K)。
命令记不清时就地问一句,不用切出去查。

**用的是当前对话的引擎与模型**:你在对话里选了什么(Codex/Claude/DeepSeek、
具体模型、codex 的推理强度),问一句命令就用什么 —— 面板标题右边会写明。
当前主机没有活跃对话时沿用它最近用过的那个,一条都没有才用默认。

**默认带上终端最近 80 行输出** —— 它是真文本,模型不用认字,还能直接引用报错
原文,比截图准得多。也可以额外附一张截图(适合问界面上的东西:表格、TUI、图形)。
同时会带上这台主机的发行版、shell、当前目录、是否 root,免得给出 apt 命令
而你的机器是 yum。

**终端内容在发出去之前统一脱敏**:`export XXX_KEY=…`、`Authorization: Bearer …`
这类会被替换成 `***`,复用的是异常日志那套规则。脱敏发生在主进程,不依赖界面。

回答里的命令会被切成独立的块,每块有「复制」和「填入终端」。

**「填入终端」只填不回车。** 模型给的可能是 `rm -rf`,也可能只是版本对不上 ——
让人看一眼再自己按回车,成本是一秒,省掉的是不可逆的事故。这条不会做成可配置项。

## 同一台主机开多个对话(分屏)

对话页顶栏的「⊞ 分屏」可以再开一个对话并排显示;会话列表里每张卡片右上角
也有 ⊞ 按钮。最多同时 4 个,「✕ 本屏」只关闭这一屏,对话本身不删、后台照常跑。

**后端本来就支持并发** —— agent 会话按 conversation 分开,你切走的对话不会
停,消息也会照常落库。分屏只是让它们同时可见。

**上限是 4 个**,原因不是界面好不好看:每个活跃对话各占一条 SSH 通道,开太多
会把远端 sshd 的 `MaxSessions` 吃光,表现为「新对话打不开」而不是任何有用的
报错。

**只能并排同一台主机的对话**。跨主机并排看没有意义 —— 工作目录和引擎都对不上,
而且很容易对着错的机器发指令。想同时盯两台机器,请在左侧切换主机。

**换主对话会清掉分屏**:否则点开另一个对话时旁边还挂着上一组的面板,看着像是
同一批,极易对错窗口发消息。

## 皮肤(界面配色)

设置 → 皮肤,提供 7 套:深邃(默认)、午夜、石墨、森野、落日、浅色、高对比。
下面的「强调色」可以只改按钮/选中态那一个颜色,不动整套配色;想还原按「恢复皮肤原色」。

**换肤会连终端一起换。** xterm 的配色是构造时传进去的普通对象、不认 CSS 变量,
所以换肤时会广播一次事件让每个终端实例重新取色 —— 否则会出现「界面切成浅色了、
终端还是一块黑」。

**唯一不跟随皮肤的地方是登录二维码那个终端。** 二维码是半块字符拼的,浅色皮肤下
会渲染成反色(浅底深码),不少手机扫码器认不出反色 QR。宁可那一块配色不统一,
也不能让人扫不出来。

### 想自己加一套皮肤

改 `src/themes.js`,往 `THEMES` 里加一项即可,不用碰 CSS。但有两条测试会卡住你:

- **必须定义 `REQUIRED_TOKENS` 里的全部颜色。** 少一个不是「稍微丑一点」——
  `background: var(--panel)` 在变量未定义时**整条声明失效**,控件直接变透明,
  而且只在切到你这套皮肤时才出现。本项目就因为 `--panel` / `--fg` 从没定义过栽过一次。
- **对比度必须达标**:正文对 4.5:1(WCAG AA),次要文字和红/绿/黄/强调色对 3:1。
  这是个天天读日志和 diff 的工具,好看但读不清是不能接受的。

跑 `node --test test/themes.test.js` 会把不达标的那一项和实际数值直接打出来。

## 后台下载任务

智能体在对话里起的后台活儿(`docker pull` 大镜像、`wget` 权重、`pip install`)
会随着对话往下滚而消失在视野里 —— 等你想起来看,要么早完了,要么卡了半小时没人知道。
顶栏的「⬇ N」角标点开就是这些任务的列表。

**它是扫出来的,不是登记出来的。** codex/claude 是在远端自己开进程跑命令的,
应用只转发输出、看不到具体命令,所以只能定期扫主机上正在跑什么。
好处是**你自己在终端里敲的下载同样会出现在这里**。

### 为什么大多数任务没有百分比

多数下载器不把总量告诉外人。硬凑一个百分比就是编数字,所以默认只报
「已写入 3.4 GB · 12 MB/s」。真正值钱的是另外三样:在跑没跑、速率、**有没有停滞**。

**停滞才是这个面板的核心。** 一个还在跑但字节数不再增长的下载,表现和正常下载
一模一样,却能白等一小时(比如源站连接超时后底层还在死等)。超过 90 秒没有新数据
写入就会标黄。

判定停滞的前提是**真的量到了字节数**。读不到 `/proc/<pid>/io`(进程属于另一个用户)时
显示的是「进度读不到」而不是「停滞」—— 把"我没量到"显示成"它卡住了",
会让人去排查一个根本不存在的故障,比不显示更糟。

### docker pull 为什么标着「按 dockerd 计」

`docker pull` 的下载**是守护进程做的**,客户端进程几乎不写盘。只看客户端会得出
"一直 0 B/s"从而把正常拉取误报成卡住,所以这里读的是 dockerd 的写入量。
代价是同时有多个拉取在跑时无法区分谁下的 —— 这种情况下会退回显示「进度读不到」,
而不是平摊出一个假数字。

### 轮询开销

面板打开时 6 秒扫一次,关掉后降到 30 秒(角标还要靠它)。**不会完全停** ——
否则你想不起来打开的时候就永远不知道有东西在下,而那正是最需要它的时候。

每次扫描占一条 SSH 通道。常驻 6 秒一次会把远端 sshd 的 `MaxSessions` 悄悄吃光,
表现为「新对话打不开」;这也是为什么每台主机同时只允许一次扫描在飞。

### 停止任务

发的是 `SIGTERM` 不是 `-9`(`docker pull` 收到 TERM 会清掉下了一半的层)。
点「停止」后要二次确认,确认框里会显示完整命令和 PID —— 任务是靠进程特征匹配出来的,
理论上可能认错,所以必须看清再停。

命令行在展示前会脱敏:`ps` 输出是密钥最典型的泄露点(`curl -H "Authorization: Bearer …"`、
带账号密码的 URL),key/token 会被替换成 `***`。
