/**
 * workflow-hint plugin for OpenCode
 *
 * 拦截 task 工具（subagent 派发），强制 agent 派发前对齐全局规则中的
 * 并发、后台、worktree 约束以及 workflow 编排推荐。
 *
 * 提示正文从 shared/policies/subagent-dispatch-hint.json 读取（SSOT），
 * 和 Claude/Qwen/Codex 的 SubagentStart hook 共享同一份内容。
 *
 * 跳过标记：task 的任意字符串参数中包含 "skip-workflow-hint" 字面值即放行。
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const pluginDir = dirname(fileURLToPath(import.meta.url))

const policyCandidates = () => {
  const roots = [
    process.env.CLAUDE_CONFIG_HOME,
    join(pluginDir, "..", ".."),         // vendor/opencode-dynamic-workflow/../../
    join(pluginDir, ".."),              // vendor/opencode-dynamic-workflow/../
    join(pluginDir, "..", "..", ".."),   // 从 ~/.config/opencode/plugins/ 软链回溯
  ].filter(Boolean)
  return roots.map((root) => join(root, "shared/policies/subagent-dispatch-hint.json"))
}

const loadDispatchHint = () => {
  for (const policyPath of policyCandidates()) {
    if (!existsSync(policyPath)) continue
    const policy = JSON.parse(readFileSync(policyPath, "utf8"))
    return (policy.template || []).join("\n")
  }
  throw new Error("subagent-dispatch-hint policy not found")
}

/**
 * OpenCode 插件入口。
 * 每次 task 工具调用都注入派发提示（和 dag-dispatch-hint 行为一致）。
 */
export const WorkflowHintPlugin = async (_ctx) => {
  const dispatchHint = loadDispatchHint()
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return

      const haystack = JSON.stringify(output.args ?? {})

      // 逃生舱：含 "skip-workflow-hint" 字面值即放行
      if (/skip-workflow-hint/i.test(haystack)) return

      throw new Error(dispatchHint)
    },
  }
}
