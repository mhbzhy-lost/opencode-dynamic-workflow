#!/usr/bin/env node
// Workflow: 并行调研
// 用法: node parallel-research.mjs [options] <question>
//
// Options:
//   --resume              从断点恢复
//   --backend cli|sdk     执行后端（默认 cli）
//   --cli-path <path>     opencode 二进制路径（默认 opencode）
//   --skip-permissions    跳过权限确认（传入 --dangerously-skip-permissions）
//
// 阶段 1: 多角度调研（3 个独立 agent）
// 阶段 2: 交叉验证
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

const question = positional.join(" ")

if (!question) {
  console.error("Usage: node parallel-research.mjs [--resume] [--backend cli|sdk] <question>")
  process.exit(1)
}

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

// 阶段 1：多角度调研
const researches = await wf.parallel([
  { type: "general", prompt: `从技术实现角度调研：${question}`, id: "research-tech" },
  { type: "general", prompt: `从最佳实践和社区经验角度调研：${question}`, id: "research-practices" },
  { type: "general", prompt: `从风险和局限性角度调研：${question}`, id: "research-risks" },
])

// 阶段 2：交叉验证
const verification = await wf.agent("general",
  `以下是三个独立调研团队对同一问题的回答。请交叉验证，` +
  `标出三方一致的结论、存在分歧的点、以及可能的盲点。\n\n` +
  `问题：${question}\n\n` +
  researches.map((r, i) => `### 调研 ${i + 1}\n${r.output || r.error || "(无输出)"}`).join("\n\n"),
  { id: "research-synthesis" }
)

wf.shutdown()
console.log(JSON.stringify({
  type: "parallel-research",
  question,
  phases: 2,
  totalAgents: researches.length + 1,
  report: verification.output,
}, null, 2))
