#!/usr/bin/env python3
"""本机终端的 PTY 桥。

为什么不用系统的 `script`:macOS/BSD 的 script 会对**它自己的 stdin**
调 tcgetattr,而我们从 Electron spawn 时 stdin 是管道,于是直接报
"tcgetattr/ioctl: Operation not supported on socket" 退出。
它能给子进程分配伪终端不假,但前提是它自己先连着一个 tty —— 这个前提
在 GUI 应用里从来不成立。

为什么不用 node-pty:那是原生模块,要针对每个 Electron ABI 重新编译,
给一个"打开终端"的功能背上跨平台构建负担不划算。

这里自己开 pty 对:子进程拿到真正的 tty(isatty 为真,claude login、
vim 之类才能正常跑),而我们这端只用普通管道通信。

窗口尺寸走 fd 3 而不是混在 stdin 里:尺寸指令若和用户输入同流,
就得设计转义,而任何转义都可能被真实输入撞上。
"""
import os
import sys
import pty
import select
import struct
import fcntl
import termios
import signal
import json

CTRL_FD = 3          # 尺寸指令通道
BUF = 65536


def set_winsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ,
                    struct.pack('HHHH', rows, cols, 0, 0))
    except OSError:
        pass          # 尺寸设不上不值得让终端挂掉


def main():
    if len(sys.argv) < 2:
        sys.stderr.write('usage: pty-helper.py <shell> [args...]\n')
        return 2
    shell, args = sys.argv[1], sys.argv[2:]
    rows = int(os.environ.get('PTY_ROWS') or 24)
    cols = int(os.environ.get('PTY_COLS') or 80)

    pid, master = pty.fork()
    if pid == 0:
        # 子进程:此时 stdin/out/err 已经是 slave 端,是货真价实的 tty
        try:
            os.execvp(shell, [shell] + args)
        except OSError as e:
            sys.stderr.write('exec %s failed: %s\n' % (shell, e))
            os._exit(127)

    set_winsize(master, rows, cols)

    # 有些平台没有 fd 3(调用方没给),没有就当作不支持改尺寸
    ctrl_open = True
    try:
        os.fstat(CTRL_FD)
    except OSError:
        ctrl_open = False

    ctrl_buf = b''
    watch = [0, master] + ([CTRL_FD] if ctrl_open else [])

    while True:
        try:
            readable, _, _ = select.select(watch, [], [])
        except (OSError, select.error):
            break

        if master in readable:
            try:
                data = os.read(master, BUF)
            except OSError:
                break              # 子进程退出时 master 读会抛 EIO,这是正常收尾
            if not data:
                break
            os.write(1, data)

        if 0 in readable:
            try:
                data = os.read(0, BUF)
            except OSError:
                data = b''
            if not data:
                # 调用方关掉了 stdin:让子进程收到 EOF,但别立刻杀它
                watch.remove(0)
                try:
                    os.close(master)
                except OSError:
                    pass
                break
            os.write(master, data)

        if ctrl_open and CTRL_FD in readable:
            try:
                chunk = os.read(CTRL_FD, BUF)
            except OSError:
                chunk = b''
            if chunk:
                ctrl_buf += chunk
                # 按行解析,半条指令留到下次
                while b'\n' in ctrl_buf:
                    line, ctrl_buf = ctrl_buf.split(b'\n', 1)
                    if not line.strip():
                        continue
                    try:
                        msg = json.loads(line.decode('utf-8'))
                        set_winsize(master, int(msg['rows']), int(msg['cols']))
                        os.kill(pid, signal.SIGWINCH)
                    except Exception:
                        pass       # 坏指令不该弄死终端
            else:
                watch.remove(CTRL_FD)
                ctrl_open = False

    try:
        _, status = os.waitpid(pid, 0)
        return os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
    except OSError:
        return 0


if __name__ == '__main__':
    sys.exit(main())
