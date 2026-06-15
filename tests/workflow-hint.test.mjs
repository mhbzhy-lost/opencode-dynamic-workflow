import { describe, it } from "node:test"
import assert from "node:assert/strict"

describe("workflow-hint plugin", () => {
  async function loadHook() {
    const mod = await import("../plugins/workflow-hint.js")
    const hooks = await mod.WorkflowHintPlugin({})
    return hooks["tool.execute.before"]
  }

  it("module exports WorkflowHintPlugin function", async () => {
    const mod = await import("../plugins/workflow-hint.js")
    assert.equal(typeof mod.WorkflowHintPlugin, "function")
  })

  it("does not export helper functions as legacy plugin entries", async () => {
    const mod = await import("../plugins/workflow-hint.js")
    const functionExports = Object.entries(mod)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)

    assert.deepEqual(functionExports, ["WorkflowHintPlugin"])
  })

  it("任何 task 调用都抛出 shared policy 提示", async () => {
    const hook = await loadHook()
    await assert.rejects(
      () => hook({ tool: "task" }, { args: { prompt: "帮我写一个 hello world 函数" } }),
      /subagent-dispatch/,
    )
  })

  it("提示内容包含 workflow 推荐", async () => {
    const hook = await loadHook()
    try {
      await hook({ tool: "task" }, { args: { prompt: "do work" } })
      assert.fail("should throw")
    } catch (err) {
      assert.ok(err.message.includes("workflow 脚本编排"))
    }
  })

  it("提示内容包含 DAG/后台/worktree 通用约束", async () => {
    const hook = await loadHook()
    try {
      await hook({ tool: "task" }, { args: { prompt: "do work" } })
      assert.fail("should throw")
    } catch (err) {
      assert.ok(err.message.includes("git worktree 隔离"))
      assert.ok(err.message.includes("后台模式"))
      assert.ok(err.message.includes("skip-dag-hint"))
    }
  })

  it("提示内容包含 workflow-usage skill 加载引导", async () => {
    const hook = await loadHook()
    try {
      await hook({ tool: "task" }, { args: { prompt: "do work" } })
      assert.fail("should throw")
    } catch (err) {
      assert.ok(err.message.includes("workflow-usage skill"))
      assert.ok(err.message.includes("API"))
    }
  })

  it("skip-workflow-hint → 放行", async () => {
    const hook = await loadHook()
    await assert.doesNotReject(() =>
      hook({ tool: "task" }, { args: { prompt: "同时执行三个探索任务 skip-workflow-hint" } }),
    )
  })

  it("非 task 工具 → 放行", async () => {
    const hook = await loadHook()
    await assert.doesNotReject(() =>
      hook({ tool: "bash" }, { args: { command: "ls" } }),
    )
  })
})
