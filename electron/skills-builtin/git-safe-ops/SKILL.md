---
name: git-safe-ops
description: 在执行任何 git 操作时使用,尤其是可能丢失工作成果的命令 —— reset --hard、checkout 覆盖、force push、rebase、clean、stash drop、分支删除。当需要提交、推送、合并、回滚、解决冲突、或清理工作区时触发。强调先备份再操作、不重写他人历史。
---

# Git 安全操作

远程协作场景下,一条命令能毁掉别人几天的工作。**破坏性操作前先留后路。**

## 动手前先看清现场

```bash
git status --short && git branch --show-current && git log --oneline -5
```

## 危险命令与安全替代

| 危险 | 风险 | 安全做法 |
|---|---|---|
| `git reset --hard` | 未提交改动永久丢失 | 先 `git stash -u`,或 `git reset --keep` |
| `git checkout -- .` | 同上 | 先确认 `git diff` 里没有要留的 |
| `git push --force` | 覆盖他人提交 | `git push --force-with-lease`(远端有新提交时会拒绝) |
| `git clean -fdx` | 删掉未跟踪文件,含本地配置 | 先 `git clean -nd` 看清单 |
| `git rebase`(已推送分支) | 重写历史,他人需强制同步 | 已推送的分支用 `git merge` |
| `git stash drop/clear` | 直接丢弃 | 先 `git stash list` 和 `git stash show -p` |

## 提交纪律

**一次提交一件事。** 混在一起的提交没法单独回滚,也没法审查。

```bash
git add -p        # 分块暂存,只提交相关部分
git diff --cached # 提交前看一眼实际内容
```

绝不 `git add -A` 之后直接提交 —— 你不知道里面混进了什么。

## 提交前的门槛

```bash
git diff --cached | grep -nEi '\+.*(sk-[A-Za-z0-9]{20,}|password\s*=|api[_-]?key\s*=)'
```

密钥一旦进入历史,`git rm` 删不掉 —— 必须去服务商那里**吊销重发**。

同时确认没有把 `node_modules/`、`dist/`、`.env`、大文件塞进去。

## 冲突处理

```bash
git status                      # 看哪些文件冲突
git diff --name-only --diff-filter=U
```

**逐个文件人工判断**,不要无脑 `--ours` / `--theirs`。解决后必须重新跑测试 —— 合并产生的代码谁都没运行过。

## 恢复:几乎什么都能救回来

误操作后先别慌,也别继续操作:

```bash
git reflog                      # 所有 HEAD 移动记录
git reset --hard <reflog中的hash>
git fsck --lost-found           # 找悬空对象
```

只要提交过,90 天内基本都在。**没提交过的改动才是真没了** —— 这就是为什么破坏性操作前要先 stash。

## 不要做的事

- 不要在用户没要求时自动 push
- 不要 `git commit --amend` 已推送的提交
- 不要删除不是自己创建的分支
- 不要在主分支上直接改 —— 先开分支
