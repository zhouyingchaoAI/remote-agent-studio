#!/bin/zsh

# 同一份脚本既可放在工作树根目录，也可放在主仓库根目录（与 .worktrees 并列）。
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
if [[ -f "$SCRIPT_DIR/epg-learning/package.json" ]]; then
  SITE_ROOT="$SCRIPT_DIR"
elif [[ -f "$SCRIPT_DIR/.worktrees/epg-learning-site/epg-learning/package.json" ]]; then
  SITE_ROOT="$SCRIPT_DIR/.worktrees/epg-learning-site"
else
  print -u2 "找不到 epg-learning 项目。请将此脚本放在 EPG 工作树根目录，或主仓库根目录。"
  exit 1
fi

APP_DIR="$SITE_ROOT/epg-learning"
HOST="127.0.0.1"
PORT_FILE="${EPG_PORT_FILE:-$SITE_ROOT/.epg-learning-port}"
PORT=""
URL=""
MARKER="EPG 全量短时冲刺"
SERVER_PID=""

if ! grep -Fq -- "$MARKER" "$APP_DIR/src/App.jsx"; then
  print -u2 "检测失败：目标工作树不是包含‘EPG 全量短时冲刺’标识的优化版站点。"
  exit 1
fi

optimized_server_healthy() {
  local source
  source="$(curl --silent --show-error --fail --connect-timeout 1 --max-time 2 "${URL}src/App.jsx" 2>/dev/null)" || return 1
  [[ "$source" == *"$MARKER"* ]]
}

set_port() {
  PORT="$1"
  URL="http://$HOST:$PORT/"
}

persist_port_choice() {
  print -r -- "$PORT" >| "$PORT_FILE"
}

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  command -v nc >/dev/null 2>&1 && nc -z "$HOST" "$PORT" >/dev/null 2>&1
}

open_site() {
  if [[ "${EPG_SKIP_OPEN:-}" == "1" ]]; then
    return 0
  fi
  open "$URL"
}

stop_owned_server() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    print "正在停止本次启动的 EPG 服务…"
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}

trap stop_owned_server EXIT INT TERM HUP

reuse_selected_server() {
  if ! optimized_server_healthy; then
    return 1
  fi
  if ! persist_port_choice; then
    print -u2 "警告：无法保存端口选择到 $PORT_FILE，下次启动前请确认使用同一端口。"
  fi
  print "已复用正在运行的优化版 EPG 站点：$URL"
  open_site
  if [[ "${EPG_SKIP_OPEN:-}" != "1" && -t 0 ]]; then
    read "?EPG 站点正在复用。按回车关闭此窗口（不会停止原服务）…"
  fi
  return 0
}

SAVED_PORT=""
if [[ -f "$PORT_FILE" ]]; then
  SAVED_PORT="$(<"$PORT_FILE")"
  if [[ "$SAVED_PORT" != "5173" && "$SAVED_PORT" != "5174" ]]; then
    print -u2 "忽略无效的 EPG 端口记录“$SAVED_PORT”，将重新选择安全端口。"
    SAVED_PORT=""
  fi
fi

if [[ -n "$SAVED_PORT" ]]; then
  set_port "$SAVED_PORT"
  if reuse_selected_server; then
    exit 0
  fi
else
  for candidate_port in 5173 5174; do
    set_port "$candidate_port"
    if reuse_selected_server; then
      exit 0
    fi
  done

  PORT=""
  URL=""
  for candidate_port in 5173 5174; do
    set_port "$candidate_port"
    if ! port_in_use; then
      break
    fi
    PORT=""
    URL=""
  done

  if [[ -z "$PORT" ]]; then
    print -u2 "$HOST 的 5173 和 5174 端口均被其他或不健康的服务占用，无法安全启动 EPG 站点。脚本不会关闭任何服务。"
    exit 1
  fi
fi

# 只有在需启动新服务时才需要本机 Node/npm；已健康的站点仍可以直接复用。
if ! command -v node >/dev/null 2>&1; then
  print -u2 "未检测到 node 命令。请安装 Node.js 20 或更高版本后重试。"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  print -u2 "未检测到 npm 命令。请安装包含 npm 的 Node.js 20 或更高版本后重试。"
  exit 1
fi

if ! NODE_VERSION="$(node --version 2>/dev/null)"; then
  print -u2 "无法读取 Node.js 版本。EPG 学习网站需要 Node.js 20 或更高版本。"
  exit 1
fi

if [[ ! "$NODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  print -u2 "无法识别 Node.js 版本输出“$NODE_VERSION”。EPG 学习网站需要 Node.js 20 或更高版本。"
  exit 1
fi

NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if (( NODE_MAJOR < 20 )); then
  print -u2 "检测到 Node.js $NODE_VERSION，但 EPG 学习网站需要 Node.js 20 或更高版本。"
  exit 1
fi

if port_in_use; then
  print -u2 "$HOST:$PORT 已被其他或不健康的服务占用，无法安全启动 EPG 站点。脚本不会关闭该服务。"
  exit 1
fi

if ! persist_port_choice; then
  print -u2 "无法保存稳定端口到 $PORT_FILE。为避免学习进度因端口变化而分散，已停止启动。"
  exit 1
fi

print "正在启动优化版 EPG 学习网站…"
npm run dev --prefix "$APP_DIR" -- --host "$HOST" --port "$PORT" --strictPort &
SERVER_PID=$!

for _ in {1..30}; do
  if optimized_server_healthy; then
    print "EPG 站点已就绪：$URL"
    open_site
    print "关闭此终端窗口仅会停止此次启动的 EPG 服务。"
    wait "$SERVER_PID"
    exit $?
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    print -u2 "EPG 服务启动后意外退出。请检查 Node.js 版本与依赖。"
    exit 1
  fi
  sleep 1
done

print -u2 "等待 EPG 优化版站点健康检查超时，将仅清理本次启动的服务。"
exit 1
