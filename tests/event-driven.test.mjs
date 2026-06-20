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
})
