#!/usr/bin/env node
// Workflow: 代码审计
// 用法: node codebase-audit.mjs [options] [target-dir]
//
// Options:
//   --resume              从断点恢复
//   --backend cli|sdk     执行后端（默认 cli）
//   --cli-path <path>     opencode 二进制路径（默认 opencode）
//   --skip-permissions    跳过权限确认
//
// 阶段 1: 并发探索（3 个只读 agent）
// 阶段 2: 基于发现的深度分析
import { createWorkflow } from "../lib/runner.mjs"

// ── 参数解析 ──
const rawArgs = process.argv.slice(2)
let resumeMode = false
let backend = "cli"
let cliPath = "opencode"
let skipPermissions = false
const positional = []

for (let i = 0; i < rawArgs.length; i++) {
  switch (rawArgs[i]) {
    case "--resume":
      resumeMode = true
      break
    case "--backend":
      backend = rawArgs[++i]
      break
    case "--cli-path":
      cliPath = rawArgs[++i]
      break
    case "--skip-permissions":
      skipPermissions = true
      break
    default:
      positional.push(rawArgs[i])
  }
}

const target = positional[0] || "src/"

// ── Workflow ──
const wf = await createWorkflow({
  resume: resumeMode,
  backend,
  cliPath,
  dangerouslySkipPermissions: skipPermissions,
})

console.error(`[workflow] 实时进度面板已就绪，执行以下命令在浏览器中打开：`)
console.error(`  open ${wf.dashboardPath}`)

if (wf.snapshot) {
  console.error(`[workflow] 从断点恢复: ${Object.keys(wf.snapshot.completedAgents || {}).length} 个 agent 已完成`)
}

// 阶段 1：并发探索
const discoveries = await wf.parallel([
  { type: "explore", prompt: `列出 ${target} 下所有公开的 API 端点和导出函数`, id: "audit-api" },
  { type: "explore", prompt: `列出 ${target} 下测试覆盖率低或无测试的文件`, id: "audit-coverage" },
  { type: "explore", prompt: `搜索 ${target} 下的 TODO、FIXME、HACK 注释，按严重性排序`, id: "audit-todos" },
])

// 阶段 2：基于发现的深度分析
const analysis = await wf.agent("general",
  `基于以下三组探索结果，输出一份结构化的代码审计报告。` +
  `报告包含：关键发现、风险排序、改进建议。\n\n` +
  discoveries.map((d, i) => `### 探索 ${i + 1}\n${d.output || d.error || "(无输出)"}`).join("\n\n"),
  { id: "audit-analysis" }
)

wf.shutdown()
console.log(JSON.stringify({
  type: "codebase-audit",
  target,
  phases: 2,
  totalAgents: discoveries.length + 1,
  report: analysis.output,
}, null, 2))
