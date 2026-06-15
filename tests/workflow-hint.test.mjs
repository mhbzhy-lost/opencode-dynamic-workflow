import { describe, it } from "node:test"
import assert from "node:assert/strict"

describe("workflow-hint plugin", () => {
  let WorkflowHintPlugin

  it("module exports WorkflowHintPlugin function", async () => {
    const mod = await import("../plugins/workflow-hint.js")
    WorkflowHintPlugin = mod.WorkflowHintPlugin
    assert.equal(typeof WorkflowHintPlugin, "function")
  })

  it('包含 "并行" → 返回提示', async () => {
    const mod = await import("../plugins/workflow-hint.js")
    const hint = mod.getWorkflowHint("我需要并行执行多个任务")
    assert.notEqual(hint, null)
    assert.ok(hint.includes("workflow-hint"))
  })

  it('包含 "workflow" → 返回提示', async () => {
    const mod = await import("../plugins/workflow-hint.js")
    const hint = mod.getWorkflowHint("请用 workflow 编排这些步骤")
    assert.notEqual(hint, null)
    assert.ok(hint.includes("workflow-hint"))
  })

  it('包含 "多个 agent" → 返回提示', async () => {
    const mod = await import("../plugins/workflow-hint.js")
    const hint = mod.getWorkflowHint("用多个 agent 同时处理")
    assert.notEqual(hint, null)
    assert.ok(hint.includes("workflow-hint"))
  })

  it("普通文本 → 返回 null", async () => {
    const mod = await import("../plugins/workflow-hint.js")
    const hint = mod.getWorkflowHint("帮我写一个 hello world 函数")
    assert.equal(hint, null)
  })

  it('返回的提示包含 "workflow-hint" 关键字', async () => {
    const mod = await import("../plugins/workflow-hint.js")
    const hint = mod.getWorkflowHint("同时做三件事")
    assert.notEqual(hint, null)
    assert.ok(typeof hint === "string")
    assert.ok(hint.includes("workflow-hint"))
  })

  it('包含 "并发" → 返回提示', async () => {
    const mod = await import("../plugins/workflow-hint.js")
    const hint = mod.getWorkflowHint("需要并发调研")
    assert.notEqual(hint, null)
  })

  it('包含 "同时" → 返回提示', async () => {
    const mod = await import("../plugins/workflow-hint.js")
    const hint = mod.getWorkflowHint("同时执行三个探索任务")
    assert.notEqual(hint, null)
  })
})
