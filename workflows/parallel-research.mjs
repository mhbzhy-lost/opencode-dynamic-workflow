#!/usr/bin/env node
// Workflow: 并行调研
// 用法: node parallel-research.mjs [options] <question>
//
// Options:
//   --resume              从断点恢复
//   --model <p/m>         provider/model，如 anthropic/claude-sonnet-4-20250514
//   --base-url <url>      连接已有 opencode server（省略则自动启动）
//   --skip-permissions    跳过权限确认（传入 --dangerously-skip-permissions）
//
// 阶段 1: 多角度调研（3 个独立 agent）
// 阶段 2: 交叉验证
import { createWorkflow } from "../lib/runner.mjs"

// ── 参数解析 ──
const rawArgs = process.argv.slice(2)
let resumeMode = false
let model = null
let baseUrl = null
let skipPermissions = false
const positional = []

for (let i = 0; i < rawArgs.length; i++) {
  switch (rawArgs[i]) {
    case "--resume":
      resumeMode = true
      break
    case "--model":
      model = rawArgs[++i]
      break
    case "--base-url":
      baseUrl = rawArgs[++i]
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
  console.error("Usage: node parallel-research.mjs [--resume] [--model <provider/model>] [--base-url <url>] <question>")
  process.exit(1)
}

// ── Workflow ──
const wf = await createWorkflow({
  resume: resumeMode,
  dangerouslySkipPermissions: skipPermissions,
  ...(baseUrl ? { baseUrl } : {}),
  ...(model ? { model } : {}),
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
