#!/usr/bin/env node
// Workflow: 多 agent 编码（带 worktree 隔离）
//
// 用法（从主仓通过 $OPENCODE_WORKFLOW_ROOT 调用）：
//   node $OPENCODE_WORKFLOW_ROOT/workflows/coding-workflow.mjs [options] --repo <path> --base <branch>
//
// Options:
//   --repo <path>        git 仓库路径（必填）
//   --base <branch>      基准分支，默认 "main"
//   --id <string>        workflow ID，用于 commit message，默认自动生成
//   --resume             从断点恢复
//   --model <p/m>        provider/model
//   --base-url <url>     连接已有 opencode server
//   --no-dashboard       不打开 dashboard
//   --skip-permissions   跳过权限确认
//
// 功能：
//   - 每层完成后自动 merge 到 accumulator
//   - shutdown 时通过 autoMerge 把 accumulator 合入 base 分支
//   - 同一文件改多份时，必须通过 deps 声明串行编排（引擎会保证顺序）
//
// 示例（在父 agent 通过 bash 工具调用）：
//   node $OPENCODE_WORKFLOW_ROOT/workflows/coding-workflow.mjs \
//     --repo /path/to/target-repo \
//     --base main \
//     --id "refactor-auth-module"
//
import { createWorkflow, resolveWorkflowConfig } from "../lib/runner.mjs"

// ── 参数解析 ──
const parsed = resolveWorkflowConfig(process.argv.slice(2), {
  workdir: ".workflow",
  openDashboard: false,
  dangerouslySkipPermissions: true,
})

// 提取 --repo 和 --base（非标准 flag，需手动处理）
let repoPath = null
let baseBranch = "main"
let workflowId = null
for (let i = 0; i < parsed.positional.length; i++) {
  const a = parsed.positional[i]
  if (a === "--repo") repoPath = parsed.positional[++i]
  else if (a === "--base") baseBranch = parsed.positional[++i]
  else if (a === "--id") workflowId = parsed.positional[++i]
}

if (!repoPath) {
  console.error(`Usage: node $OPENCODE_WORKFLOW_ROOT/workflows/coding-workflow.mjs --repo <path> [options]

Required:
  --repo <path>        git 仓库路径

Optional:
  --base <branch>      基准分支，默认 "main"
  --id <string>        workflow ID，用于 commit message
  --model <p/m>        provider/model
  --base-url <url>     连接已有 server
  --no-dashboard       不打开 dashboard
  --skip-permissions   跳过权限确认
  --resume             从快照恢复
`)
  process.exit(1)
}

// ── Workflow 配置（worktree 启用）──
const wf = await createWorkflow({
  workdir: parsed.workdir,
  resume: parsed.resume,
  openDashboard: parsed.openDashboard,
  dangerouslySkipPermissions: parsed.dangerouslySkipPermissions,
  ...(parsed.model ? { model: parsed.model } : {}),
  ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
  id: workflowId || `coding-wf-${Date.now()}`,
  worktree: {
    enable: true,
    repoDir: repoPath,
    baseBranch,
    autoMerge: true,  // shutdown 时合入 base 分支
  },
})

if (wf.snapshot) {
  console.error(`[workflow] 从断点恢复: ${Object.keys(wf.snapshot.completedAgents || {}).length} 个 agent 已完成`)
}
console.log(`[workflow] worktree enabled: base=${baseBranch}, will auto-merge on shutdown`)

// ── DAG 示例（改不同文件 → 并行；改同文件 → 串行） ──
// 注意：此处仅为演示，实际 prompt 由父 agent 通过 IPC 注入（wf.needPrompt）
const results = await wf.dag([
  // 层 1：并行（每个 agent 改独立文件，worktree 会隔离）
  {
    id: "impl-util-A",
    type: "general",
    prompt: `在 ${repoPath} 的 worktree 中：创建 src/utils/newFeatureA.js，实现基础数据结构。
完成后执行 git add + git commit。`,
    deps: [],
  },
  {
    id: "impl-util-B",
    type: "general",
    prompt: `在 ${repoPath} 的 worktree 中：创建 src/utils/newFeatureB.js，实现辅助函数。
完成后执行 git add + git commit。`,
    deps: [],
  },
  // 层 2：依赖层 1（合并两个模块的导出到 index）
  {
    id: "integrate-index",
    type: "general",
    prompt: `在 ${repoPath} 的 worktree 中：更新 src/index.js，导出 newFeatureA 和 newFeatureB。
注意：layer 1 的 impl-util-A 和 impl-util-B 已在 accumulator 分支中提交。
完成后执行 git add + git commit。`,
    deps: ["impl-util-A", "impl-util-B"],
  },
])

// ── 输出 ──
await wf.shutdown()
console.log(JSON.stringify({
  type: "coding-workflow",
  workflowId: workflowId || "coding-wf-" + Date.now(),
  repo: repoPath,
  baseBranch,
  layers: 2,
  totalAgents: 3,
  layersDetail: {
    1: ["impl-util-A", "impl-util-B"],
    2: ["integrate-index"],
  },
  results: Object.fromEntries(
    Object.entries(results).map(([id, r]) => [id, { status: r.status, error: r.error }])
  ),
}, null, 2))
