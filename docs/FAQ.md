# FAQ · 常见问题

> Bilingual: 中文在前,English below.

## 连接与代理

**连不上主机 / Connection refused。** 先用系统终端 `ssh user@host -p 端口` 验证连通;通了但应用连不上,多半是私钥格式(应用支持 OpenSSH 格式,PuTTY 的 .ppk 需先转换)或密码含特殊字符,查看侧边栏状态提示与「环境配置」页日志。

**主机指纹变更告警。** 这是防中间人攻击的 TOFU 校验。服务器重装/换机后指纹会变,向管理员核实后再点信任;不明原因的变更不要点。

**远程机访问不了 OpenAI/Anthropic。** 「环境配置」页选代理模式:本机有代理(如 Clash 7890 端口)选「SSH 反向隧道」,远程流量经隧道走你本机代理;远程与本机同局域网可选「局域网直连」。点「应用代理配置并测试」看连通性结果。国产模型端点(DeepSeek/GLM/Kimi/通义)国内服务器一般直连即可,无需代理。

**断线后会怎样。** 自动指数退避重连并重建反向隧道;正在执行的那一轮会中断,已产生的消息不丢,重连后可继续发。

## 安装与认证

**一键安装失败。** 看「环境配置」页日志:缺 Node 会自动走 nvm 免 root 安装(慢,耐心);下载超时通常是网络问题,先把代理配好再重试;老系统(glibc < 2.28)会自动换兼容版 Node。

**Codex 认证下发后仍提示未登录。** 确认本机 `~/.codex/auth.json` 存在且本机 codex 可用;ChatGPT 登录态有有效期,过期需本机重新 `codex login` 再下发。

**Claude 认证下发不了。** macOS 的 Claude 凭据在钥匙串里无法复制,两个替代:写入 `ANTHROPIC_API_KEY`,或在「终端」页运行 `claude` 交互登录。

**API Key 存在哪,安全吗。** 远程 `~/.remote-agent-env.sh`,600 权限,不写入 bashrc 明文,配置文件里只引用变量名;本机主机凭据经系统钥匙串加密。

## 对话与引擎

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
