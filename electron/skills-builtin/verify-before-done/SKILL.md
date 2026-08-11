---
name: verify-before-done
description: 在声称任务完成、修复成功或代码可用之前使用。适用于任何改动了代码、配置或脚本的任务 —— 提交前必须实际运行测试、lint、构建或复现步骤并贴出真实输出。当你准备说"已完成""已修复""应该可以了"时触发。不适用于纯问答、纯查询、未改动任何文件的场景。
---

# 交付前自检

**核心规则:没有跑过的东西不算做完。** "应该可以了""理论上没问题"等同于没做。

## 必须执行的顺序

1. **先复现原问题** —— 如果是修 bug,先证明你能看到那个错误。看不到就说明你还没定位到,不要动手改。
2. **改动**
3. **再次复现** —— 同一条命令,错误必须消失。
4. **跑回归** —— 项目里已有的测试/lint/构建,全部跑一遍。

## 按项目类型选择验证命令

先看项目里实际有什么,不要凭猜测:

```bash
cat package.json | grep -A20 '"scripts"'   # Node
ls Makefile pyproject.toml Cargo.toml go.mod 2>/dev/null
```

常见组合(有哪个跑哪个,不要跳过):

| 类型 | 验证命令 |
|---|---|
| Node/前端 | `npm test` → `npx eslint .` → `npm run build` |
| Python | `pytest` → `ruff check .` → `mypy .` |
| Go | `go test ./...` → `go vet ./...` → `go build ./...` |
| Rust | `cargo test` → `cargo clippy` → `cargo build` |

单文件语法检查不算验证,只能算最低门槛。

## 汇报纪律

贴**真实输出**,不要转述:

```
✅ npm test        220 passed, 0 failed
✅ npx eslint      no issues
✅ npm run build   built in 756ms
```

任何一项失败、跳过或无法执行,**必须明说**,并说明原因。绝不能用"测试通过"概括一次没跑完的验证。

## 常见的自欺行为

- 只跑了新增的那个测试,没跑全量 —— 你可能刚把别处改坏了
- 测试失败后改测试去迁就代码 —— 先判断到底是代码错还是测试错,判断依据要说出来
- 用 `try/catch` 或 `|| true` 把报错吞掉当作"修好了"
- 构建有警告就当成功 —— 先看清警告是不是你引入的
