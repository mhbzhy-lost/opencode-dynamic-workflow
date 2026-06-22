---
name: workflow-rollback
description: "Use when dynamic workflow encounters issues and needs to be rolled back to DAG dispatch, or when debugging vendor/opencode-dynamic-workflow failures"
---

# Dynamic Workflow 回退预案

workflow 系统替换 DAG 插件后，如果出现问题需要回退到旧方案，本文档给出
两种场景下的完整操作步骤。

## 场景一：第二期刚完成，还没有后续迭代

第二期是一个原子 commit（或少数几个连续 commit），直接 revert 即可。

### 受影响文件清单

| 文件 | 第二期做了什么 | revert 后恢复到什么 |
|------|---------------|-------------------|
| `opencode/plugins/dag-dispatch-hint.js` | 已删除 | 从 git 历史恢复为活跃插件 |
| `shared/policies/subagent-dispatch-hint.json` | 替换为 workflow 提示文本 | 恢复为 DAG 拦截文本 |
| `shared/hooks/subagent-dispatch-hint.sh` | 跟随 policy 更新 | 恢复原文（仅读 JSON，无逻辑变化） |
| `claude/CLAUDE.md` §并发、§Subagent | 规则切换为 workflow 优先 | 恢复为 DAG 拦截优先 |
| `claude/CLAUDE.reason.md` §并发、§Subagent | 同步更新 why 伴文 | 恢复原 why |
| `init_opencode.sh` | 新增 workflow 子模块配置调用 | 移除该调用 |
| `codex/hooks/tests/test_codex_hooks.py` | 断言更新为 workflow 关键词 | 恢复为 DAG 关键词断言 |
| `docs/knowledge/subagent-dispatch-hook.md` | 更新为 workflow 架构描述 | 恢复为 DAG 架构描述 |
| `docs/knowledge/opencode-dynamic-workflow.md` | 新增 | 删除 |
| `~/.config/opencode/plugins/subagent-hint.js` | init 脚本创建的软链 | 手动删除 |

### 操作步骤

```bash
# 1. 找到第二期的 commit 范围
git log --oneline --all | head -20
# 假设第二期 commit 是 abc1234..def5678

# 2. Revert（按逆序，最新的先 revert）
git revert --no-commit def5678
git revert --no-commit abc1234
# 如果是单个 commit：
# git revert --no-commit <commit-hash>

# 3. 检查 revert 结果
git diff --cached --stat
# 确认只影响上述文件清单

# 4. 删除 workflow 插件软链
rm -f ~/.config/opencode/plugins/subagent-hint.js

# 5. 验证 DAG 系统恢复正常
python3 -m unittest \
  codex.hooks.tests.test_codex_hooks.CodexHooksTest.test_opencode_dag_dispatch_hint_matches_global_concurrency_rules \
  codex.hooks.tests.test_codex_hooks.CodexHooksTest.test_subagent_dispatch_hint_policy_is_four_host_single_source \
  codex.hooks.tests.test_codex_hooks.CodexHooksTest.test_shared_subagent_dispatch_hook_outputs_policy_as_additional_context

# 6. 确认 CLAUDE.md 规则一致性
grep -A5 '## 并发' claude/CLAUDE.md
grep -A5 '## Subagent' claude/CLAUDE.md
# 应该看到 DAG 拦截规则，而非 workflow 优先规则

# 7. 提交
git commit -m "revert: 回退 dynamic workflow 第二期，恢复 DAG 插件"

# 8. 重新运行 init
bash init_opencode.sh
```

### 不需要回退的部分

- `vendor/opencode-dynamic-workflow/` 子模块目录 — 保留不删。它是独立
  git 仓库，不影响其他模块。回退只是不再让主仓规则引导 agent 使用它。
- 子模块的远端仓库 `mhbzhy-lost/opencode-dynamic-workflow` — 保留。

## 场景二：第二期之后又有了其他迭代，想单独回退 workflow

后续迭代可能改了 `CLAUDE.md` 的其他章节、`init_opencode.sh` 的其他逻辑、
`test_codex_hooks.py` 的其他测试。直接 `git revert` 会引入不相关的冲突。

### 手动回退步骤

按文件逐个还原 workflow 相关改动，不动其他改动。

#### Step 1: 恢复 DAG 插件

```bash
# 从第二期之前的 commit 恢复 dag-dispatch-hint.js
git show <pre-phase2-commit>:opencode/plugins/dag-dispatch-hint.js \
  > opencode/plugins/dag-dispatch-hint.js
```

#### Step 2: 恢复 shared policy

```bash
git show <pre-phase2-commit>:shared/policies/subagent-dispatch-hint.json \
  > shared/policies/subagent-dispatch-hint.json
```

#### Step 3: 恢复 CLAUDE.md 的 §并发 和 §Subagent

只还原这两个章节，不动文件其他部分。用 diff 对比第二期前后的
`claude/CLAUDE.md`，手动还原 `## 并发` 和 `## Subagent` 两节的内容。

```bash
# 查看第二期改了什么
git diff <pre-phase2-commit> <phase2-commit> -- claude/CLAUDE.md
```

同步还原 `claude/CLAUDE.reason.md` 对应的两节。

#### Step 4: 恢复 init_opencode.sh

删除第二期新增的 workflow 子模块配置调用块：

```bash
# 删除这段（通常在 ensure_opencode_required_submodules 或 main flow 中）：
# vendor/opencode-dynamic-workflow
# local workflow_install="$CLAUDE_CONFIG_HOME/vendor/opencode-dynamic-workflow/install-opencode.sh"
# if [ -f "$workflow_install" ]; then
#   OPENCODE_CONFIG_DIR="$OPENCODE_CONFIG_DIR" bash "$workflow_install"
# fi
```

#### Step 5: 恢复回归测试

```bash
git show <pre-phase2-commit>:codex/hooks/tests/test_codex_hooks.py \
  > codex/hooks/tests/test_codex_hooks.py
```

如果后续迭代也改了这个测试文件，需要手动 merge：只还原 workflow 相关的
断言变更，保留其他迭代新增的测试。

#### Step 6: 恢复知识文档

```bash
# 还原 subagent-dispatch-hook.md
git show <pre-phase2-commit>:docs/knowledge/subagent-dispatch-hook.md \
  > docs/knowledge/subagent-dispatch-hook.md

# 删除 workflow 知识文档
rm -f docs/knowledge/opencode-dynamic-workflow.md
```

#### Step 7: 清理运行时

```bash
# 删除 workflow 插件软链
rm -f ~/.config/opencode/plugins/subagent-hint.js

# 重新运行 init 同步 DAG 插件
bash init_opencode.sh
```

#### Step 8: 验证

```bash
# 回归测试
python3 -m unittest \
  codex.hooks.tests.test_codex_hooks.CodexHooksTest.test_opencode_dag_dispatch_hint_matches_global_concurrency_rules \
  codex.hooks.tests.test_codex_hooks.CodexHooksTest.test_subagent_dispatch_hint_policy_is_four_host_single_source \
  codex.hooks.tests.test_codex_hooks.CodexHooksTest.test_shared_subagent_dispatch_hook_outputs_policy_as_additional_context

# shell 语法检查
bash -n shared/hooks/subagent-dispatch-hint.sh init_opencode.sh

# CLAUDE.md / CLAUDE.reason.md 同步检查
# 确认 §并发 和 §Subagent 两节在两文件中一一对应
```

#### Step 9: 提交

```bash
git add -A
git commit -m "revert(workflow): 手动回退 dynamic workflow，恢复 DAG 插件"
```

## 快速定位第二期 commit 的方法

```bash
# 方法 1: 按 commit message 搜索
git log --oneline --all --grep="workflow"

# 方法 2: 按文件搜索
git log --oneline -- shared/policies/subagent-dispatch-hint.json

# 方法 3: 按时间范围（第二期执行日期）
git log --oneline --after="2026-06-15" --before="2026-06-16"
```

## 风险提示

- 回退后 `vendor/opencode-dynamic-workflow/` 仍存在但不再被引用，不影响
  任何功能。如果要彻底清理，可以删除该目录并从 `.gitmodules` 中移除（如果
  已注册为 submodule）。
- 回退时最容易遗漏的是 `claude/CLAUDE.reason.md` — 它必须与 `CLAUDE.md`
  同步更新，否则违反仓内规则约束（两文件节标题一一对应）。
- 回退后运行 `init_opencode.sh` 会重新同步 DAG 插件软链到
  `~/.config/opencode/plugins/`，但不会自动删除 `workflow-hint.js` 软链，
  必须手动删。
