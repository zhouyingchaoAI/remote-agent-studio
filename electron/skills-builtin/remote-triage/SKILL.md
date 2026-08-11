---
name: remote-triage
description: 在远程服务器上排查环境问题时使用 —— 命令找不到、权限被拒、端口不通、磁盘满、进程起不来、装完还是用不了、代理连不上外网。当出现 command not found、Permission denied、Connection refused、No space left、Exec format error 等系统层报错时触发。不适用于纯应用代码逻辑 bug。
---

# 远程主机排障

远程环境的问题几乎都出在五个地方:**PATH、权限、端口、磁盘、架构**。按顺序排查比乱猜快得多。

## 先拿全局快照

一条命令看清现场:

```bash
uname -sm; whoami; echo "HOME=$HOME"; df -h / | tail -1; free -h 2>/dev/null | head -2
```

## command not found

装了却用不了,九成是 PATH 没包含安装位置:

```bash
echo "$PATH"
ls ~/.npm-global/bin ~/.local/bin ~/.cargo/bin 2>/dev/null
command -v <cmd> || find "$HOME" -maxdepth 4 -name '<cmd>' -type f 2>/dev/null
```

注意:**非交互式 SSH 不加载 `~/.bashrc`**,所以你手动 ssh 上去能用,脚本里就不能用。要么用绝对路径,要么在命令前显式 `export PATH=...`。

## Exec format error / cannot execute binary file

架构不匹配 —— 在 ARM 机器上装了 x86 的二进制(或反过来):

```bash
uname -m            # aarch64/arm64 vs x86_64/amd64
file $(command -v <cmd>)
```

同时检查**残留的坏软链**,它会遮挡住正确的版本:

```bash
ls -l $(command -v <cmd>) ~/.local/bin/<cmd> ~/.npm-global/bin/<cmd> 2>/dev/null
```

## Permission denied

分清是哪一种:

```bash
ls -ld <路径>              # 目录权限
id                         # 当前用户和组
touch <目录>/.probe && rm <目录>/.probe && echo "可写"
```

免 root 安装优先装到 `$HOME`(nvm、`--user`、`--prefix=$HOME/.local`),不要动系统目录。

## 端口不通 / Connection refused

```bash
ss -tlnp 2>/dev/null | grep :<port> || netstat -tlnp 2>/dev/null | grep :<port>
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>
```

本机通、外部不通 → 服务只监听了 `127.0.0.1`,或防火墙/安全组拦了。

## 外网访问失败 / 代理问题

```bash
env | grep -iE 'proxy'
curl -sS -m 12 -o /dev/null -w '%{http_code}\n' https://api.anthropic.com
```

**间歇性失败必须多次采样**,单次成功说明不了任何问题:

```bash
for i in 1 2 3 4 5; do curl -sS -o /dev/null -m 12 -w '%{http_code} ' https://<host>; done; echo
```

出现 `000` 是连不上,`503` 常见于代理节点限流。成功率不到 100% 就是不稳,长任务必断。

## 磁盘满

```bash
df -h; du -sh ~/.cache ~/.npm ~/.local 2>/dev/null | sort -h
```

inode 耗尽也会报"磁盘满"但 `df -h` 看着没满:`df -i`。

## 汇报

说清三件事:**现象、根因、验证**。不要只说"修好了" —— 贴出修复后重跑的真实输出。
