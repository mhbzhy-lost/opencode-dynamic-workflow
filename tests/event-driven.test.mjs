import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { EventDAGExecutor } from "../lib/executor/event-driven.mjs"

describe("EventDAGExecutor.emitEvent", () => {
  it("smoke test - does not crash on emitEvent", async () => {
    const mockClient = {
      global: { health: async () => ({ data: { healthy: true } }) },
      session: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { id: "s-1" } }),
        prompt: async (opts) => ({ data: { parts: [{ type: "text", text: "ok" }] } }),
      },
    }
    const mockIpc = {
      advancePhase: () => {},
      emitEvent: () => {},
      updateAgentStatus: () => {},
    }

    const executor = new EventDAGExecutor({})
    const completed = await executor.execute(
      [
        { id: "a", type: "coder", prompt: "A", deps: [] },
        { id: "b", type: "coder", prompt: "B", deps: ["a"] },
      ],
      mockClient,
      mockIpc
    )

    assert.ok(completed instanceof Map)
    assert.equal(completed.size, 2)
    assert.equal(completed.get("a").result.status, "completed")
    assert.equal(completed.get("b").result.status, "completed")
  })

  it("executes diamond DAG with correct dependency ordering", async () => {
    const executionOrder = []

    const mockClient = {
      global: { health: async () => ({ data: { healthy: true } }) },
      session: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { id: "s-" + Math.random().toString(36).slice(2) } }),
        prompt: async (opts) => {
          const text = opts.body.parts[0].text
          executionOrder.push(text)
          await new Promise(r => setTimeout(r, 5))
          return { data: { parts: [{ type: "text", text: `done: ${text}` }] } }
        },
      },
    }
    const mockIpc = {
      advancePhase: () => {},
      emitEvent: () => {},
      updateAgentStatus: () => {},
    }

    const executor = new EventDAGExecutor({})
    const completed = await executor.execute(
      [
        { id: "A", type: "coder", prompt: "create A", deps: [] },
        { id: "B", type: "coder", prompt: "create B", deps: ["A"] },
        { id: "C", type: "coder", prompt: "create C", deps: ["A"] },
        { id: "D", type: "coder", prompt: "merge D", deps: ["B", "C"] },
      ],
      mockClient,
      mockIpc
    )

    assert.equal(completed.size, 4)
    for (const id of ["A", "B", "C", "D"]) {
      assert.equal(completed.get(id).result.status, "completed")
    }

    const idxA = executionOrder.indexOf("create A")
    const idxB = executionOrder.indexOf("create B")
    const idxC = executionOrder.indexOf("create C")
    const idxD = executionOrder.indexOf("merge D")
    assert.ok(idxA < idxB, "A must execute before B")
    assert.ok(idxA < idxC, "A must execute before C")
    assert.ok(idxB < idxD, "B must execute before D")
    assert.ok(idxC < idxD, "C must execute before D")
  })

  it("substitutes upstream outputs into dependent prompts", async () => {
    const prompts = []

    const mockClient = {
      global: { health: async () => ({ data: { healthy: true } }) },
      session: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { id: "s-" + Math.random().toString(36).slice(2) } }),
        prompt: async (opts) => {
          const text = opts.body.parts[0].text
          prompts.push({ id: opts.path.id, text })
          return { data: { parts: [{ type: "text", text: `RESULT(${text})` }] } }
        },
      },
    }
    const mockIpc = {
      advancePhase: () => {},
      emitEvent: () => {},
      updateAgentStatus: () => {},
    }

    const executor = new EventDAGExecutor({})
    await executor.execute(
      [
        { id: "R", type: "researcher", prompt: "research topic", deps: [] },
        { id: "S", type: "writer", prompt: "summarize {{R.output}}", deps: ["R"] },
      ],
      mockClient,
      mockIpc
    )

    const summaryCall = prompts.find(p => p.text.startsWith("summarize"))
    assert.ok(summaryCall, "should have a summarize call")
    assert.ok(summaryCall.text.includes("RESULT(research topic)"),
      `expected substitution, got: ${summaryCall.text}`)
  })
})
