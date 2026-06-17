---
name: workflow-usage
description: opencode-dynamic-workflow 的 API 参考（createWorkflow、wf.agent、wf.parallel、wf.dag、wf.needPrompt、IPC）。需要编写或运行 workflow 脚本时加载。
---

# Workflow 编排使用指南

## When to Use

- 需要 >=3 个 agent 协作完成任务
- agent 之间有 DAG 依赖（Phase 2 需要 Phase 1 的输出）
- 需要实时干预能力（暂停 / 恢复 / 快照断点续跑）
- 需要并发可视化（dashboard）

不需要时：单个 subagent、2 个独立 subagent 直接用 Task tool 派发即可。

## 推荐用法（实测验证，避免常见坑）

### 自定义脚本：用 `resolveWorkflowConfig` 一行搞定参数

**推荐写法**：
```javascript
import { createWorkflow, resolveWorkflowConfig } from "../../vendor/opencode-dynamic-workflow/lib/runner.mjs"

// 一行：CLI 参数解析 + 安全默认值（openDashboard: false, dangerouslySkipPermissions: true）
const config = resolveWorkflowConfig(process.argv.slice(2), {
  workdir: ".workflow",           // 可选：自定义工作目录
  // maxConcurrent: 4,            // 可选：最大并行数（默认 4）
  // model: "anthropic/claude-sonnet-4-20250514",  // 可选：指定模型
})
const wf = await createWorkflow(config)
// ... 你的 DAG 编排 ...
await wf.shutdown()
```

**支持的 CLI 参数**（全部可选）：
- `--model <provider/model>` — 指定 LLM
- `--base-url <url>` — 连接已有 opencode server
- `--workdir <path>` — IPC 目录
- `--max-concurrent <n>` — 最大并行数
- `--dashboard` / `--no-dashboard` — 是否打开 dashboard
- `--skip-permissions` / `--no-skip-permissions` — 是否跳过权限确认
- `--resume` — 从快照恢复

**默认值**（覆盖硬编码）：
| 参数 | 默认 | 理由 |
|---|---|---|
| `openDashboard` | `false` | 主 agent 后台调度，弹窗会卡死 |
| `dangerouslySkipPermissions` | `true` | workflow 驱动的 runs 已有用户授权 |
| `maxConcurrent` | `4` | 保守并行，避免 LLM quota 暴涨 |

**优先级**：CLI flag > `userDefaults` 参数 > 硬编码默认。

### 三个易错点（实测踩坑）

⚠️ **1. DAG 层数是引擎算的，不是人画的**

你写 `deps: ["A", "B"]`，引擎自动拓扑排序分层。**不要在注释里写"这是第 2 层"**——引擎可能拆出 3 层。

✅ 正确：只声明 `deps`，层数交给引擎
❌ 错误：手动计算层数并假设某节点一定在某层

⚠️ **2. `needsPrompt: true` 使用 idle-aware 超时（300 秒）**

DAG 节点设 `needsPrompt: true` 时，引擎 emit `[workflow:need_agent]` 事件，然后等待主 agent 写 `.workflow/commands/agent_prompt_<id>.json`。

**超时机制**：
- 默认超时 300 秒（5 分钟），但**只在所有节点都空闲时才计时**
- 如果同层有其他 agent 还在运行，即使这个节点等了很久，也不会超时
- 只有当整个 DAG 中没有任何 agent 在跑，且当前节点仍未收到 prompt，才开始计时
- 超时后该节点抛出 Error，`wf.dag()` 立即 reject，进程非零退出
- 不会"部分完成"——任何一个节点超时整体即失败

**场景示例**：
```
Layer 1: [A (ready, 跑 600ms), B (needsPrompt, 等待)]
```
A 跑 600ms 期间，B 的超时不启动。A 完成后，若 B 仍未收到 prompt，才开始 300s 倒计时。

✅ 正确：主代理在 5 分钟内响应即可
❌ 错误：以为 60 秒必须响应（旧版本行为）

⚠️ **3. `{{id.error}}` 在节点成功时展开为空字符串**

插值 `{{id.error}}` 在节点 `status: "completed"` 时是 `""`（空串），**不是 `undefined`**。

- 如果你写 `若 {{id.error}} 不为空则…`，LLM 可能理解错空串含义
- ✅ 推荐：用 `{{id.status}}` 做条件判断（`completed` / `error`），再决定是否读 `{{id.error}}`

### 参数优先级指南

**必须理解**（写错会失败）：
- `deps`：DAG 依赖声明
- `needsPrompt`：双向通信语义（60 秒阻塞）
- `{{id.output}}` / `{{id.error}}` / `{{id.status}}`：插值占位符

**可以省略**（用默认即可）：
- `model`：省略时用 opencode 配置默认
- `maxConcurrent`：默认 4
- `openDashboard` / `dangerouslySkipPermissions`：用 `resolveWorkflowConfig` 自动处理

**几乎不需要**：
- `baseUrl`：本地调试才用
- `worktree`：仅 coding workflow 需要（改同文件的场景）

## 两种使用方式

### 方式 A：使用预定义 workflow 模板（推荐起步）

**内置模板**只读，位于 `$OPENCODE_WORKFLOW_ROOT/workflows/`：

| 模板 | 文件 | 用途 |
|---|---|---|
| parallel-research | `parallel-research.mjs` | 3 角度并行调研 + 1 交叉验证 |

#### parallel-research 用法

```bash
node $OPENCODE_WORKFLOW_ROOT/workflows/parallel-research.mjs \
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
node $OPENCODE_WORKFLOW_ROOT/workflows/parallel-research.mjs \
  --model "anthropic-idealab/claude-sonnet-4-20250514" \
  "分析 React Server Components 的性能优势和适用场景"

# 复合问题（用一段文本描述）
node $OPENCODE_WORKFLOW_ROOT/workflows/parallel-research.mjs \
  "比较 Vite、Turbopack、Rspack 的构建速度、生态成熟度和迁移成本"
```

**错误示例（不要这样做）：**
```bash
# 错误：不存在 --topic 和 --questions 参数
node $OPENCODE_WORKFLOW_ROOT/workflows/parallel-research.mjs \
  --topic "主题" --questions "问题1" "问题2"

# 错误：问题文本没有引号包裹，会被 shell 拆分
node $OPENCODE_WORKFLOW_ROOT/workflows/parallel-research.mjs 分析 React 性能
```

### 方式 B：编写自定义 workflow 脚本

当预定义模板不满足需求时，用 `createWorkflow` API 编写自定义脚本。

#### 最小可用示例

```javascript
#!/usr/bin/env node
// 写法 A（推荐）：脚本放在目标仓的 .workflow/scripts/ 下，
// 用绝对路径引用 workflow lib（依赖 $OPENCODE_WORKFLOW_ROOT 环境变量，
// install-opencode.sh 自动注册到 shell）。
// 注意：ESM 静态 import 不支持模板字符串，必须用动态 await import()：
const { createWorkflow } = await import(`${process.env.OPENCODE_WORKFLOW_ROOT}/lib/runner.mjs`)

// 写法 B：脚本放在 $OPENCODE_WORKFLOW_ROOT/workflows/ 下（仅 vendor 团队使用，
// 用户自定义脚本不要往 vendor 目录写）。使用相对 import：
// import { createWorkflow } from "../lib/runner.mjs"

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
  `基于以下发现生成报告：\n` +
  results.map((r, i) => `### ${r.id}\n${r.output || r.error}`).join("\n"),
  { id: "synthesis" }
)

await wf.shutdown()
console.log(report.output)
```

#### createWorkflow(config) API

```javascript
const wf = await createWorkflow({
  id: string,                   // workflow ID，用于 audit log 和 commit message（可选，默认自动生成）
  model: string | { providerID, modelID },  // 默认 model（可选）
  baseUrl: string,          // 已有 server URL（省略则自动启动）
  workdir: string,          // IPC 目录，默认 ".workflow"
  maxConcurrent: number,    // 最大并行 agent 数，默认 10
  resume: boolean,          // 从快照恢复
  openDashboard: boolean,   // 自动打开 dashboard（默认 true，--no-dashboard 设为 false）
  worktree: {               // git worktree 隔离（可选，仅 coding 类 workflow 启用）
    enable: boolean,
    repoDir: string,        // git 仓库路径
    baseBranch: string,     // 基准分支，默认 "main"
    branch: string?,        // 指定时走 legacy single-worktree；省略时用 per-node worktrees
    autoMerge: boolean?,    // 为 true 时 shutdown 自动 merge accumulator 到 baseBranch
    exec: function?,        // 注入的 exec 函数（测试用）
  },
  dangerouslySkipPermissions: boolean,
})
```

**worktree 行为说明：**
- `enable: true` 且未指定 `branch` 时，自动使用 **per-node worktrees + accumulator**：
  - 每个 DAG 节点创建独立 worktree（`merge-gate.createNode`）
  - 每层完成后 consolidate 到 accumulator，移除节点 worktree
  - DAG 结束后 accumulator 包含所有层的累积结果
- `enable: true` 且指定 `branch` 时，走 **legacy single-worktree**（所有 agent 共享 1 个 worktree）
- `autoMerge: true` 时 shutdown 自动将 accumulator merge 到 baseBranch（冲突时抛异常）
- 默认 `autoMerge: false`，shutdown 后保留 worktree 与 accumulator 分支，主 agent 手动 merge

**coding workflow 并发策略：**
- agent 改不同文件 → DAG 同层无 deps，自动并行
- agent 改同一文件 → 必须通过 `deps` 串行编排（层间顺序由 DAG 拓扑决定）
- 当 DAG 同层 agent 改不同文件时，单 worktree 下的 git 可以干净合并；如果需要真并行（每个 agent 独立工作目录），参考 `worktree.mjs` 的 accumulator API 自行编排

**返回对象：**

| 方法/属性 | 说明 |
|---|---|
| `wf.agent(type, prompt, opts?)` | 运行单个 agent。返回 `{ id, status, output, durationMs }` 或 `{ id, status, error, durationMs }` |
| `wf.parallel(specs)` | 并行运行多个 agent。specs: `[{ type, prompt, id?, model? }]`。返回结果数组，顺序与 specs 一致 |
| `wf.dag(nodeSpecs)` | DAG 编排：自动拓扑分层，层内并发，下游可用 `{{id.output}}` 插值上游输出。返回 `{ id: result }` 对象 |
| `wf.needPrompt(id, spec?)` | 双向通信：输出 `[workflow:need_agent]` 事件（**注意**：事件 type 是 `need_agent`，不是 `need_prompt`），阻塞等待主 agent 写 `{commandsDir}/agent_prompt_{id}.json`，返回 prompt 字符串 |
| `wf.readPrompt(id)` | 同步读已存在的 prompt，不存在返回 null |
| `wf.status()` | 读取当前 IPC 状态 |
| `wf.dashboardPath` | dashboard HTML 文件路径 |
| `wf.snapshot` | 恢复的快照数据（未恢复则 null） |
| `wf.worktree` | worktree 状态（`{ path, branch, repoDir, baseBranch }`），未启用或未创建时为 undefined |
| `wf.shutdown()` | 清理：停止命令循环、写结果（含 worktree 信息）、关闭自动启动的 server。**返回 Promise**，必须 `await` 以确保 `autoMerge` 完成 |

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

#### DAG 编排（推荐用于复杂依赖）

**直接 prompt：**
```javascript
const results = await wf.dag([
  { id: "research",   type: "explore", prompt: "调研 X",          deps: [] },
  { id: "design",     type: "general", prompt: "设计方案",         deps: ["research"] },
  { id: "impl-A",     type: "coder",   prompt: "实现模块 A",       deps: ["design"] },
  { id: "impl-B",     type: "coder",   prompt: "实现模块 B",       deps: ["design"] },
  { id: "integrate",  type: "coder",   prompt: "集成：{{impl-A.output}} + {{impl-B.output}}", deps: ["impl-A", "impl-B"] },
])
// results["integrate"].output — 最终输出
```

**needsPrompt（R3 合规，prompt 由主 agent 构造）：**
```javascript
const results = await wf.dag([
  { id: "explore", type: "explore", prompt: "调研 X",      deps: [] },
  { id: "implement", type: "coder", needsPrompt: true,     deps: ["explore"] },
  //                                       ^^^^^^^^^^^^^^^^
  // emit [workflow:need_agent] {"id":"implement","spec":{...}}
  // 阻塞等待主 agent 写 {commandsDir}/agent_prompt_implement.json
  // 主 agent 可基于 explore.output 构造精确的 implement prompt
])
```

**插值占位符：**
- `{{depId.output}}` — 上游 agent 的输出文本
- `{{depId.error}}` — 上游 agent 的错误信息
- `{{depId.status}}` — 上游 agent 的状态

**DAG node spec 字段：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 唯一节点 ID |
| `type` | string? | agent 类型（默认 `"general"`） |
| `prompt` | string | 任务 prompt，支持 `{{dep.output}}` 插值。与 `needsPrompt` 互斥 |
| `needsPrompt` | boolean? | 为 `true` 时省略 prompt，emit `need_agent` 事件等主 agent 注入 |
| `deps` | string[] | 依赖的节点 ID 列表 |

每层 DAG 执行前后自动 emit `[workflow:phase_start]` / `[workflow:phase_end]` 事件（stdout JSON line），payload 含 `{ phase, total, nodes, results }`。

#### 双向通信（R3：prompt 由主 agent 控制）

```javascript
// workflow 声明需要 prompt，主 agent 注入
const promptA = await wf.needPrompt("task-A", { type: "coder", deps: ["phase-1"] })
// stdout 输出: [workflow:need_agent] {"id":"task-A","spec":{"type":"coder","deps":["phase-1"]}}
// 阻塞等待主 agent 写入 {commandsDir}/agent_prompt_task-A.json
// 返回 prompt 字符串

const result = await wf.agent("coder", promptA, { id: "task-A" })
```

**主 agent 侧操作：**
```bash
# 监听 stdout 的 [workflow:need_agent] 事件
# 构造 prompt 后写入：
echo '{"prompt": "你的任务描述..."}' > .workflow/commands/agent_prompt_task-A.json
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
# 通过 $OPENCODE_WORKFLOW_ROOT 绝对路径调用（推荐：cwd 不敏感）
node $OPENCODE_WORKFLOW_ROOT/workflows/parallel-research.mjs \
  --model "anthropic-idealab/claude-sonnet-4-20250514" \
  "研究问题文本"
```

**必须用后台 subagent 执行**（workflow 本身是长耗时进程）：
- 通过 Task tool 派发一个 general subagent，让它执行 bash 命令运行 workflow
- 或直接在 Bash tool 中后台运行（`&` + `wait`）

## Checklist

- [ ] 确认 agent 数量 >=3 或有 DAG 依赖，否则直接用 Task tool
- [ ] 选择预定义模板或编写自定义脚本（自定义脚本放在**目标仓**，不要往 vendor 目录写）
- [ ] 指定 `--model`（provider 名必须与 opencode 配置中的 provider ID 一致）
- [ ] 问题文本用引号包裹，避免 shell 拆分
- [ ] coding workflow 改同文件：用 deps 串行；改不同文件：同层无 deps 自动并行
- [ ] coding workflow 启用 `worktree.enable: true`（默认 per-node worktrees + accumulator）
- [ ] 设 `worktree.autoMerge: true` 让 shutdown 自动 merge accumulator 到 baseBranch
- [ ] 复杂依赖用 `wf.dag()` 声明式编排（自动拓扑分层 + 插值 + phase 事件）
- [ ] 需要主 agent 运行时构造 prompt 时，DAG 节点设 `needsPrompt: true`（R3 合规）
