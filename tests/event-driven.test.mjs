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

  describe("needMerge callback", () => {
    function makeMockClients() {
      const promptCalls = []
      return {
        promptCalls,
        mockClient: {
          global: { health: async () => ({ data: { healthy: true } }) },
          session: {
            list: async () => ({ data: [] }),
            create: async () => ({ data: { id: "s-" + Math.random().toString(36).slice(2) } }),
            prompt: async (opts) => {
              const text = opts.body.parts[0].text
              promptCalls.push({ id: opts.path.id, text })
              return { data: { parts: [{ type: "text", text: `ok:${text}` }] } }
            },
          },
        },
        mockIpc: {
          advancePhase: () => {},
          emitEvent: () => {},
          updateAgentStatus: () => {},
        },
      }
    }

    function makeMockAtomPool() {
      const mergeCalls = []
      const targetAtom = { cwd: "/mock/target-atom", pid: 99, branch: "wf/D", process: { killed: false } }
      return {
        mergeCalls,
        targetAtom,
        mockPool: {
          acquire: async () => targetAtom,
          fork: async () => makeAtom("fork-" + Math.random()),
          merge: async (src, target) => { mergeCalls.push({ src, target }) },
          recycleAtom: async () => {},
          release: () => {},
        },
      }
    }

    function makeAtom(branch) {
      return { cwd: "/mock/" + branch, pid: Math.floor(Math.random() * 10000), branch, process: { killed: false } }
    }

    it("needMerge is called for each toMerge dep in multi-dep node (diamond DAG)", async () => {
      const { mockClient, mockIpc } = makeMockClients()
      const { targetAtom, mockPool } = makeMockAtomPool()

      const mergeCalls = []
      const executor = new EventDAGExecutor({})
      executor.atomPool = mockPool
      executor.needMerge = async ({ nodeId, sourceNode, targetAtom: tAtom }) => {
        mergeCalls.push({ nodeId, sourceNodeId: sourceNode.id, targetPath: tAtom.cwd })
        return { success: true }
      }

      await executor.execute(
        [
          { id: "A", type: "coder", prompt: "A", deps: [] },
          { id: "B", type: "coder", prompt: "B", deps: ["A"] },
          { id: "C", type: "coder", prompt: "C", deps: ["A"] },
          { id: "D", type: "coder", prompt: "D", deps: ["B", "C"] },
        ],
        mockClient,
        mockIpc
      )

      // D has 2 deps, one uses inherit/acquire (primary), one uses merge
      // at least one needMerge call expected
      assert.ok(mergeCalls.length >= 1, `at least 1 needMerge call expected, got ${mergeCalls.length}`)

      const dMerges = mergeCalls.filter(m => m.nodeId === "D")
      assert.ok(dMerges.length >= 1, `${dMerges.length} needMerge calls for D, expected >= 1`)
      assert.ok(
        dMerges.every(m => m.targetPath === "/mock/target-atom"),
        "targetAtom should be the acquired atom"
      )

      // atomPool.merge should NOT have been called (needMerge replaced it)
      mockPool.merge = async () => {
        throw new Error("atomPool.merge should not be called when needMerge is set")
      }
    })

    it("when needMerge rejects, the node is marked as failed (merge conflict)", async () => {
      const { mockClient, mockIpc } = makeMockClients()
      const { mockPool } = makeMockAtomPool()

      const executor = new EventDAGExecutor({})
      executor.atomPool = mockPool
      executor.needMerge = async ({ nodeId }) => {
        if (nodeId === "D") {
          throw new Error("CONFLICT: file.txt modified in both branches")
        }
        return { success: true }
      }

      const completed = await executor.execute(
        [
          { id: "A", type: "coder", prompt: "A", deps: [] },
          { id: "B", type: "coder", prompt: "B", deps: ["A"] },
          { id: "C", type: "coder", prompt: "C", deps: ["A"] },
          { id: "D", type: "coder", prompt: "D", deps: ["B", "C"] },
        ],
        mockClient,
        mockIpc
      )

      // D failed due to merge conflict, should not be in completed
      assert.ok(!completed.has("D"), "D should not be in completed (merge conflict)")
      assert.ok(completed.has("A"), "A should be in completed")
      assert.ok(completed.has("B"), "B should be in completed")
      assert.ok(completed.has("C"), "C should be in completed")

      // Verify failed map
      assert.ok(executor.failed.has("D"), "D should be in failed map")
    })

    it("needMerge not called for single-dep nodes (inherit/fork, no merge needed)", async () => {
      const { mockClient, mockIpc } = makeMockClients()
      const { mockPool } = makeMockAtomPool()

      let callCount = 0
      const executor = new EventDAGExecutor({})
      executor.atomPool = mockPool
      executor.needMerge = async () => {
        callCount++
        return { success: true }
      }

      await executor.execute(
        [
          // Chain: A → B → C, all single-dep, no merge happens
          { id: "A", type: "coder", prompt: "A", deps: [] },
          { id: "B", type: "coder", prompt: "B", deps: ["A"] },
          { id: "C", type: "coder", prompt: "C", deps: ["B"] },
        ],
        mockClient,
        mockIpc
      )

      assert.equal(callCount, 0, "needMerge should not be called for single-dep chains")
    })
  })
})
