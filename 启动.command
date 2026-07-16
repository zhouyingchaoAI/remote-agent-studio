#!/bin/bash
# Remote Agent Studio 一键启动脚本(macOS)
cd "$(dirname "$0")"
echo "==> Remote Agent Studio 部署目录: $(pwd)"

# 1. 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js。请先安装(任选其一):"
  echo "   brew install node"
  echo "   或访问 https://nodejs.org 下载安装包"
  read -p "安装完成后按回车重试,或 Ctrl+C 退出..."
  exec "$0"
fi
echo "==> Node $(node -v) / npm $(npm -v)"

# 2. 依赖检查:缺失、或从其他平台(如 Windows)拷贝过来的,都重装
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
if [ -d node_modules ] && [ ! -d node_modules/electron/dist/Electron.app ]; then
  echo "==> 检测到 node_modules 不是 macOS 版本(可能从 Windows 拷贝),重新安装..."
  rm -rf node_modules
fi
if [ ! -d node_modules ]; then
  echo "==> 安装依赖中(约 1-3 分钟,含 Electron 下载)..."
  npm install --no-audit --no-fund || { echo "❌ npm install 失败"; read -p "按回车退出"; exit 1; }
fi

# 3. 构建前端并启动
echo "==> 构建并启动应用..."
npm run build && npx electron .

read -p "应用已退出,按回车关闭窗口"
