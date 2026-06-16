#!/usr/bin/env node
// Workflow: 并行调研
// 用法: node parallel-research.mjs [options] <question>
//
// Options:
//   --resume              从断点恢复
//   --model <p/m>         provider/model，如 anthropic/claude-sonnet-4-20250514
//   --base-url <url>      连接已有 opencode server（省略则自动启动）
//   --no-dashboard        不自动打开 dashboard
//   --skip-permissions    跳过权限确认（传入 --dangerously-skip-permissions）
//
// DAG:
//   research-tech/practices/risks  (层 1: 并发)
//   research-synthesis             (层 2: 依赖层 1)
import { createWorkflow } from "../lib/runner.mjs"

// ── 参数解析 ──
const rawArgs = process.argv.slice(2)
let resumeMode = false
let model = null
let baseUrl = null
let openDashboard = true
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
    case "--no-dashboard":
      openDashboard = false
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
  openDashboard,
  dangerouslySkipPermissions: skipPermissions,
  ...(baseUrl ? { baseUrl } : {}),
  ...(model ? { model } : {}),
})

if (wf.snapshot) {
  console.error(`[workflow] 从断点恢复: ${Object.keys(wf.snapshot.completedAgents || {}).length} 个 agent 已完成`)
}

// ── DAG 编排（2 层）──
const results = await wf.dag([
  { id: "research-tech",      type: "general", prompt: `从技术实现角度调研：${question}`, deps: [] },
  { id: "research-practices", type: "general", prompt: `从最佳实践和社区经验角度调研：${question}`, deps: [] },
  { id: "research-risks",     type: "general", prompt: `从风险和局限性角度调研：${question}`, deps: [] },
  { id: "research-synthesis", type: "general", prompt:
    `以下是三个独立调研团队对同一问题的回答。请交叉验证，` +
    `标出三方一致的结论、存在分歧的点、以及可能的盲点。\n\n` +
    `问题：${question}\n\n` +
    `### 调研 1\n{{research-tech.output}}\n\n### 调研 2\n{{research-practices.output}}\n\n### 调研 3\n{{research-risks.output}}`,
    deps: ["research-tech", "research-practices", "research-risks"] },
])

// ── 插值 ──
// research-synthesis 的 prompt 模板需要在运行时替换上游输出
const synthesisResult = results["research-synthesis"]

wf.shutdown()
console.log(JSON.stringify({
  type: "parallel-research",
  question,
  layers: 2,
  totalAgents: 4,
  report: synthesisResult.output,
}, null, 2))
