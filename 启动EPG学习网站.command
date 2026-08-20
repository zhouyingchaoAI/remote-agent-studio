#!/bin/zsh
set -e

SITE_DIR="$(cd "$(dirname "$0")/.worktrees/epg-learning-site" && pwd)"
cd "$SITE_DIR"

echo "正在启动 EPG 学习网站…"
npm run dev --prefix epg-learning -- --host 127.0.0.1 &
SERVER_PID=$!

for i in {1..20}; do
  if curl -fsS http://127.0.0.1:5173/ >/dev/null 2>&1; then
    open http://127.0.0.1:5173/
    echo "网站已打开。关闭此窗口即可停止网站。"
    wait "$SERVER_PID"
    exit 0
  fi
  sleep 1
done

echo "启动失败，请检查 Node.js 是否可用。"
kill "$SERVER_PID" 2>/dev/null || true
read "?按回车键关闭窗口…"
