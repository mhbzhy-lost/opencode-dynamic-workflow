---
name: workflow-usage
description: Use when dispatching >=3 subagents, or when subagents have DAG dependencies, or when real-time intervention (pause/resume/snapshot) is needed. Provides the complete API reference and usage guide for opencode-dynamic-workflow. Key rules -- single subagent or <=2 independent subagents can dispatch directly (background mode required); >=3 or DAG deps must use workflow script; independent tasks must be dispatched in parallel; coding tasks require git worktree isolation. Load this skill BEFORE writing any workflow invocation or createWorkflow call.
---

# Workflow 编排使用指南

## When to Use

- 需要 >=3 个 agent 协作完成任务
- agent 之间有 DAG 依赖（Phase 2 需要 Phase 1 的输出）
- 需要实时干预能力（暂停 / 恢复 / 快照断点续跑）
- 需要并发可视化（dashboard）

不需要时：单个 subagent、2 个独立 subagent 直接用 Task tool 派发即可。

## 两种使用方式

### 方式 A：使用预定义 workflow 模板（推荐起步）

子模块 `vendor/opencode-dynamic-workflow/workflows/` 下有现成模板：

| 模板 | 文件 | 用途 |
|---|---|---|
| parallel-research | `parallel-research.mjs` | 3 角度并行调研 + 1 交叉验证 |
| codebase-audit | `codebase-audit.mjs` | 3 并发探索 + 1 深度分析 |

#### parallel-research 用法

```bash
node vendor/opencode-dynamic-workflow/workflows/parallel-research.mjs \
  [--model <provider/model>] \
  [--base-url <url>] \
  [--resume] \
  [--no-dashboard] \
  [--skip-permissions] \
  "<问题文本>"
```

**参数说明：**
- 位置参数（必填）：自由文本形式的研究问题，直接写在引号内
- `--model`：指定 LLM，格式 `provider/model`，如 `anthropic-idealab/claude-sonnet-4-20250514`
- `--base-url`：连接已有的 opencode server（省略则自动启动临时 server）
- `--resume`：从 `.workflow/snapshot.json` 断点恢复
- `--no-dashboard`：不自动在浏览器中打开 dashboard（用户要求静默时使用）
- `--skip-permissions`：跳过权限确认

**正确示例：**
```bash
# 单个研究问题
node workflows/parallel-research.mjs \
  --model "anthropic-idealab/claude-sonnet-4-20250514" \
  "分析 React Server Components 的性能优势和适用场景"

# 复合问题（用一段文本描述）
node workflows/parallel-research.mjs \
  "比较 Vite、Turbopack、Rspack 的构建速度、生态成熟度和迁移成本"
```

**错误示例（不要这样做）：**
```bash
# 错误：不存在 --topic 和 --questions 参数
node workflows/parallel-research.mjs \
  --topic "主题" --questions "问题1" "问题2"

# 错误：问题文本没有引号包裹，会被 shell 拆分
node workflows/parallel-research.mjs 分析 React 性能
```

#### codebase-audit 用法

```bash
node vendor/opencode-dynamic-workflow/workflows/codebase-audit.mjs \
  [--model <provider/model>] \
  [--base-url <url>] \
  [--resume] \
  [--no-dashboard] \
  [--skip-permissions] \
  [target-dir]
```

- 位置参数（可选）：目标目录，默认 `src/`

### 方式 B：编写自定义 workflow 脚本

当预定义模板不满足需求时，用 `createWorkflow` API 编写自定义脚本。

#### 最小可用示例

```javascript
#!/usr/bin/env node
import { createWorkflow } from "../lib/runner.mjs"
// 或 import { createWorkflow } from "opencode-dynamic-workflow"

const wf = await createWorkflow({
  model: "anthropic-idealab/claude-sonnet-4-20250514",
  // baseUrl: "http://localhost:4800",  // 可选：连接已有 server
})

// Phase 1：并行
const results = await wf.parallel([
  { type: "explore", prompt: "搜索 src/ 下所有 TODO 注释", id: "scan-todos" },
  { type: "explore", prompt: "列出所有公开 API 端点", id: "scan-api" },
  { type: "explore", prompt: "找出没有测试的模块", id: "scan-tests" },
])

// Phase 2：综合（使用 Phase 1 的输出）
const report = await wf.agent("general",
  `基于以下发现生成报告：\n\n` +
  results.map((r, i) => `### ${r.id}\n${r.output || r.error}`).join("\n\n"),
  { id: "synthesis" }
)

wf.shutdown()
console.log(report.output)
```

#### createWorkflow(config) API

```javascript
const wf = await createWorkflow({
  model: string | { providerID, modelID },  // 默认 model（可选）
  baseUrl: string,          // 已有 server URL（省略则自动启动）
  workdir: string,          // IPC 目录，默认 ".workflow"
  maxConcurrent: number,    // 最大并行 agent 数，默认 10
  resume: boolean,          // 从快照恢复
  openDashboard: boolean,   // 自动打开 dashboard（默认 true，--no-dashboard 设为 false）
  dangerouslySkipPermissions: boolean,
})
```

**返回对象：**

| 方法/属性 | 说明 |
|---|---|
| `wf.agent(type, prompt, opts?)` | 运行单个 agent。返回 `{ id, status, output, durationMs }` 或 `{ id, status, error, durationMs }` |
| `wf.parallel(specs)` | 并行运行多个 agent。specs: `[{ type, prompt, id?, model? }]`。返回结果数组，顺序与 specs 一致 |
| `wf.status()` | 读取当前 IPC 状态 |
| `wf.dashboardPath` | dashboard HTML 文件路径 |
| `wf.snapshot` | 恢复的快照数据（未恢复则 null） |
| `wf.shutdown()` | 清理：停止命令循环、写结果、关闭自动启动的 server |

**agent spec 字段：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | agent 类型：`"explore"` / `"general"` |
| `prompt` | string | 任务 prompt |
| `id` | string? | 自定义 agent ID（省略则自动生成） |
| `model` | string? | 覆盖 workflow 级别的 model |

#### model 指定规则

1. **workflow 级默认**：`createWorkflow({ model: "provider/model" })` — 所有 agent 使用
2. **per-agent 覆盖**：`{ type: "general", prompt: "...", model: "other/model" }` — 单个 agent 使用不同 model
3. **省略**：使用 opencode server 的默认配置
4. **格式**：`"provider/model"` 字符串或 `{ providerID: "...", modelID: "..." }` 对象

#### Phase 编排模式

```javascript
// 顺序 Phase
const p1 = await wf.parallel([...])   // Phase 1: 并行
const p2 = await wf.agent(...)        // Phase 2: 用 p1 结果
const p3 = await wf.parallel([...])   // Phase 3: 基于 p2 再并行

// 纯并行（无依赖）
const all = await wf.parallel([
  { type: "explore", prompt: "任务 A", id: "a" },
  { type: "explore", prompt: "任务 B", id: "b" },
  { type: "general", prompt: "任务 C", id: "c" },
])
```

## IPC 与 Dashboard

运行期间 `.workflow/` 目录包含：

| 文件 | 用途 |
|---|---|
| `status.json` | 所有 agent 的实时状态 |
| `dashboard.html` | 自刷新 HTML 面板（`open .workflow/dashboard.html`） |
| `events/` | 事件日志 |
| `commands/` | 命令文件（暂停/终止） |
| `snapshot.json` | 断点快照（`--resume` 用） |
| `result.json` | 最终结果 |

**干预命令**（运行中写入 `commands/`）：

```bash
# 暂停
echo '{"command":"pause"}' > .workflow/commands/001-pause.json

# 终止
echo '{"command":"abort"}' > .workflow/commands/002-abort.json
```

## 调用方式

workflow 脚本是独立 Node 进程，从主 agent 的视角通过 Bash tool 调用：

```bash
# 在子模块目录下运行
node vendor/opencode-dynamic-workflow/workflows/parallel-research.mjs \
  --model "anthropic-idealab/claude-sonnet-4-20250514" \
  "研究问题文本"
```

**必须用后台 subagent 执行**（workflow 本身是长耗时进程）：
- 通过 Task tool 派发一个 general subagent，让它执行 bash 命令运行 workflow
- 或直接在 Bash tool 中后台运行（`&` + `wait`）

## Checklist

- [ ] 确认 agent 数量 >=3 或有 DAG 依赖，否则直接用 Task tool
- [ ] 选择预定义模板或编写自定义脚本
- [ ] 指定 `--model`（provider 名必须与 opencode 配置中的 provider ID 一致）
- [ ] 问题文本用引号包裹，避免 shell 拆分
- [ ] coding 任务的 agent 使用 git worktree 隔离
- [ ] workflow 完成后检查 `.workflow/status.json` 确认所有 agent completed
- [ ] 合并 worktree 后跑验证测试
