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

  it("task + background=true → 放行", async () => {
    const hook = await loadHook()
    await assert.doesNotReject(() =>
      hook({ tool: "task" }, { args: { prompt: "do work", background: true } }),
    )
  })

  it("task + background 未设置 → 拦截", async () => {
    const hook = await loadHook()
    await assert.rejects(
      () => hook({ tool: "task" }, { args: { prompt: "do work" } }),
      (err) => {
        assert.ok(err.message.includes("background"), "提示应包含 'background'")
        return true
      },
    )
  })

  it("task + background=false → 拦截", async () => {
    const hook = await loadHook()
    await assert.rejects(
      () => hook({ tool: "task" }, { args: { prompt: "do work", background: false } }),
      (err) => {
        assert.ok(err.message.includes("后台"), "提示应包含'后台'")
        return true
      },
    )
  })

  it("非 task 工具 → 放行", async () => {
    const hook = await loadHook()
    await assert.doesNotReject(() =>
      hook({ tool: "bash" }, { args: { command: "ls" } }),
    )
  })

  it("拦截信息不推荐 workflow 编排决策", async () => {
    const hook = await loadHook()
    try {
      await hook({ tool: "task" }, { args: { prompt: "do work" } })
      assert.fail("should throw")
    } catch (err) {
      assert.ok(!err.message.includes("workflow 脚本编排"), "不应包含编排推荐")
      assert.ok(!err.message.includes("workflow-usage skill"), "不应包含 skill 引导")
      assert.ok(!err.message.includes("skip-workflow-hint"), "不应包含逃生舱标记")
    }
  })
})
