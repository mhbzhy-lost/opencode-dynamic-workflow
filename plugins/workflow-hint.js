/**
 * workflow-hint plugin for OpenCode
 *
 * 拦截 task 工具（subagent 派发），强制要求后台模式。
 * 编排方式（workflow vs 直接 subagent）的决策由 AGENTS.md 规则驱动，
 * 不在插件层拦截。
 */

export const WorkflowHintPlugin = async (_ctx) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return
      if (output.args?.background === true) return
      throw new Error(
        "[background-required] subagent 必须使用后台模式派发（background: true）。\n" +
        "前台模式会阻塞主对话，请设置 background: true 后重试。"
      )
    },
  }
}
