/**
 * workflow-hint plugin for OpenCode
 *
 * 检测用户消息中的多 agent 编排意图，提示使用 workflow 脚本编排。
 * 遵循 dag-dispatch-hint 插件格式：导出命名函数，返回 hook 对象。
 */

const KEYWORDS = [
  "并行",
  "并发",
  "workflow",
  "多个 agent",
  "多个agent",
  "同时",
  "编排",
  "多 agent",
  "多agent",
]

const HINT_TEXT = `[workflow-hint] 检测到多 subagent 编排需求。

推荐使用 workflow 脚本编排（确定性更高、可复用、支持实时干预）：
  node .workflow/scripts/<name>.mjs

预定义 workflow 模板：
  - codebase-audit.mjs: 代码审计（探索 + 分析）
  - parallel-research.mjs: 并行调研（多角度 + 交叉验证）

直接派发 subagent 仍然允许的场景：
  a. 单个 subagent（无编排需求）
  b. explore/scout 只读探索
  c. 简单的 1-2 个独立 subagent，写入范围不重叠`

/**
 * 检测 prompt 是否包含多 agent 编排相关关键词。
 * @param {string} prompt
 * @returns {string|null} hint 文本或 null
 */
export function getWorkflowHint(prompt) {
  if (!prompt || typeof prompt !== "string") return null
  const lower = prompt.toLowerCase()
  const matched = KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))
  return matched ? HINT_TEXT : null
}

/**
 * OpenCode 插件入口。
 * 拦截 task 工具调用，当 prompt 暗示多 agent 编排时注入提示。
 */
export const WorkflowHintPlugin = async (_ctx) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return

      const haystack = JSON.stringify(output.args ?? {})

      // 逃生舱：含 "skip-workflow-hint" 字面值即放行
      if (/skip-workflow-hint/i.test(haystack)) return

      const hint = getWorkflowHint(haystack)
      if (hint) {
        throw new Error(hint)
      }
    },
  }
}
