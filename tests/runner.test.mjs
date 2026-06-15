import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { resolve } from "node:path"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockClient(options = {}) {
  const sessions = new Map()
  let sessionCounter = 0
  const abortedSessions = []
  const promptCalls = []         // records all prompt() call bodies
  return {
    global: {
      health: async () => ({ data: { healthy: options.healthy !== false } }),
    },
    session: {
      create: async ({ body }) => {
        const id = `ses_${++sessionCounter}`
        sessions.set(id, { title: body?.title })
        return { data: { id } }
      },
      prompt: async ({ path, body }) => {
        promptCalls.push(body)
        const text = body.parts?.[0]?.text || ""
        if (options.promptDelay)
          await new Promise((r) => setTimeout(r, options.promptDelay))
        if (options.shouldFail)
          throw new Error(options.failMessage || "mock error")
        return {
          data: {
            parts: [
              {
                type: "text",
                text: options.responseText || `Response to: ${text.slice(0, 50)}`,
              },
            ],
          },
        }
      },
      abort: async ({ path }) => {
        abortedSessions.push(path.id)
        sessions.delete(path.id)
        return { data: {} }
      },
    },
    // test helpers
    _sessions: sessions,
    _abortedSessions: abortedSessions,
    _promptCalls: promptCalls,
  }
}

function createMockIpc() {
  const events = []
  const statuses = {}
  let state = "running"
  let commands = []
  let snapshot = null
  let result = null
  return {
    updateAgentStatus: (id, info) => {
      statuses[id] = { ...statuses[id], ...info }
    },
    updateState: (s) => {
      state = s
    },
    emitEvent: (e) => {
      events.push(e)
      return events.length
    },
    consumeCommands: () => {
      const c = [...commands]
      commands = []
      return c
    },
    writePid: (_pid) => {},
    readPid: () => null,
    writeSnapshot: (s) => {
      snapshot = s
    },
    readSnapshot: () => snapshot,
    writeResult: (r) => {
      result = r
    },
    readStatus: () => ({ state, agents: statuses }),
    // test helpers
    _events: events,
    _statuses: statuses,
    _state: () => state,
    _pushCommand: (cmd) => commands.push(cmd),
    _snapshot: () => snapshot,
    _result: () => result,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWorkflow", () => {
  it("returns correct interface shape", { timeout: 10000 }, async () => {
    const mockClient = createMockClient()
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
    })

    assert.equal(typeof wf.agent, "function")
    assert.equal(typeof wf.parallel, "function")
    assert.equal(typeof wf.status, "function")
    assert.equal(typeof wf.shutdown, "function")
    assert.equal(typeof wf.dashboardPath, "string")
    assert.ok(wf.dashboardPath.endsWith("dashboard.html"))

    wf.shutdown()
  })

  it("throws when health check fails", { timeout: 10000 }, async () => {
    const mockClient = createMockClient({ healthy: false })
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    await assert.rejects(
      () =>
        createWorkflow({
          _mockClient: mockClient,
          _mockIpc: mockIpc,
        }),
      (err) => {
        assert.ok(err instanceof Error)
        assert.ok(err.message.toLowerCase().includes("health"))
        return true
      }
    )
  })
})

describe("wf.agent()", () => {
  it("successfully executes a single agent", { timeout: 10000 }, async () => {
    const mockClient = createMockClient({ responseText: "hello world" })
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
    })

    const result = await wf.agent("coder", "Write hello world")

    assert.equal(result.status, "completed")
    assert.equal(result.output, "hello world")
    assert.equal(typeof result.id, "string")
    assert.equal(typeof result.durationMs, "number")
    assert.ok(result.durationMs >= 0)

    wf.shutdown()
  })

  it("returns failed result on error", { timeout: 10000 }, async () => {
    const mockClient = createMockClient({
      shouldFail: true,
      failMessage: "prompt crashed",
    })
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
    })

    const result = await wf.agent("coder", "Do something")

    assert.equal(result.status, "failed")
    assert.equal(result.error, "prompt crashed")
    assert.equal(typeof result.id, "string")
    assert.equal(typeof result.durationMs, "number")

    wf.shutdown()
  })
})

describe("wf.parallel()", () => {
  it(
    "executes multiple agents concurrently",
    { timeout: 10000 },
    async () => {
      const mockClient = createMockClient({ responseText: "ok" })
      const mockIpc = createMockIpc()
      const { createWorkflow } = await import("../lib/runner.mjs")

      const wf = await createWorkflow({
        _mockClient: mockClient,
        _mockIpc: mockIpc,
      })

      const results = await wf.parallel([
        { type: "coder", prompt: "Task A" },
        { type: "coder", prompt: "Task B" },
        { type: "reviewer", prompt: "Task C" },
      ])

      assert.equal(results.length, 3)
      for (const r of results) {
        assert.equal(r.status, "completed")
        assert.equal(r.output, "ok")
      }

      wf.shutdown()
    }
  )

  it("respects maxConcurrent limit", { timeout: 15000 }, async () => {
    // Track concurrency via a counter
    let currentConcurrency = 0
    let maxObservedConcurrency = 0

    const mockClient = createMockClient()
    // Override prompt to track concurrency
    const origPrompt = mockClient.session.prompt
    mockClient.session.prompt = async (args) => {
      currentConcurrency++
      if (currentConcurrency > maxObservedConcurrency) {
        maxObservedConcurrency = currentConcurrency
      }
      await new Promise((r) => setTimeout(r, 100))
      currentConcurrency--
      return origPrompt(args)
    }

    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
      maxConcurrent: 2,
    })

    const specs = Array.from({ length: 5 }, (_, i) => ({
      type: "coder",
      prompt: `Task ${i}`,
    }))

    const results = await wf.parallel(specs)

    assert.equal(results.length, 5)
    assert.ok(
      maxObservedConcurrency <= 2,
      `Expected max concurrency <= 2, got ${maxObservedConcurrency}`
    )

    wf.shutdown()
  })

  it(
    "partial failure does not affect other agents",
    { timeout: 10000 },
    async () => {
      // Build a client where the 2nd prompt fails
      let callCount = 0
      const mockClient = createMockClient()
      const origPrompt = mockClient.session.prompt
      mockClient.session.prompt = async (args) => {
        callCount++
        if (callCount === 2) throw new Error("agent 2 exploded")
        return origPrompt(args)
      }

      const mockIpc = createMockIpc()
      const { createWorkflow } = await import("../lib/runner.mjs")

      const wf = await createWorkflow({
        _mockClient: mockClient,
        _mockIpc: mockIpc,
        maxConcurrent: 1, // serial to control ordering
      })

      const results = await wf.parallel([
        { type: "coder", prompt: "A" },
        { type: "coder", prompt: "B" },
        { type: "coder", prompt: "C" },
      ])

      assert.equal(results.length, 3)
      assert.equal(results[0].status, "completed")
      assert.equal(results[1].status, "failed")
      assert.equal(results[1].error, "agent 2 exploded")
      assert.equal(results[2].status, "completed")

      wf.shutdown()
    }
  )
})

describe("wf.status()", () => {
  it("returns current workflow state", { timeout: 10000 }, async () => {
    const mockClient = createMockClient()
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
    })

    const st = wf.status()
    assert.ok(st !== null && typeof st === "object")
    assert.equal(st.state, "running")
    assert.ok("agents" in st)

    wf.shutdown()
  })
})

describe("wf.shutdown()", () => {
  it("cleans up command loop", { timeout: 10000 }, async () => {
    const mockClient = createMockClient()
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
    })

    wf.shutdown()

    // After shutdown, pushing a command should not be consumed
    mockIpc._pushCommand({ type: "abort" })
    // Give it time to NOT consume
    await new Promise((r) => setTimeout(r, 1500))
    // The abort command should still be unconsumed (or state unchanged)
    assert.equal(mockIpc._state(), "running")
  })
})

describe("command handling", () => {
  it("stop command aborts a session", { timeout: 10000 }, async () => {
    const mockClient = createMockClient({ promptDelay: 2000 })
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
    })

    // Start an agent in background
    const agentPromise = wf.agent("coder", "Long running task", {
      id: "agent-stop-test",
    })

    // Wait a moment, then issue stop
    await new Promise((r) => setTimeout(r, 200))
    mockIpc._pushCommand({ type: "stop", agentId: "agent-stop-test" })

    // Wait for command loop to process
    await new Promise((r) => setTimeout(r, 1500))

    assert.ok(
      mockClient._abortedSessions.length > 0,
      "Expected at least one session to be aborted"
    )

    // Clean up — the agentPromise may resolve with failed/stopped
    await agentPromise.catch(() => {})
    wf.shutdown()
  })

  it("abort command stops all agents", { timeout: 10000 }, async () => {
    const mockClient = createMockClient({ promptDelay: 3000 })
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    // Override process.exit for testing
    let exitCalled = false
    const origExit = process.exit
    process.exit = (code) => {
      exitCalled = true
    }

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
    })

    // Start agents in background
    const p1 = wf.agent("coder", "Task 1", { id: "a1" })
    const p2 = wf.agent("coder", "Task 2", { id: "a2" })

    // Issue abort
    await new Promise((r) => setTimeout(r, 200))
    mockIpc._pushCommand({ type: "abort" })

    // Wait for command loop
    await new Promise((r) => setTimeout(r, 1500))

    assert.equal(mockIpc._state(), "aborted")

    // Restore process.exit
    process.exit = origExit

    await Promise.allSettled([p1, p2])
    wf.shutdown()
  })
})

describe("resume mode", () => {
  it(
    "skips already-completed agents from snapshot",
    { timeout: 10000 },
    async () => {
      const mockClient = createMockClient({ responseText: "fresh result" })
      const mockIpc = createMockIpc()

      // Pre-populate snapshot with a completed agent
      mockIpc.writeSnapshot({
        completedAgents: {
          "agent-done": {
            id: "agent-done",
            status: "completed",
            output: "cached result",
            durationMs: 42,
          },
        },
        pendingSpecs: [{ id: "agent-new", type: "coder", prompt: "New task" }],
      })

      const { createWorkflow } = await import("../lib/runner.mjs")

      const wf = await createWorkflow({
        _mockClient: mockClient,
        _mockIpc: mockIpc,
        resume: true,
      })

      // snapshot should be populated
      assert.ok(wf.snapshot !== null)
      assert.ok(wf.snapshot.completedAgents["agent-done"])

      wf.shutdown()
    }
  )
})

describe("model passthrough", () => {
  it("passes workflow-level model to SDK prompt body", { timeout: 10000 }, async () => {
    const mockClient = createMockClient({ responseText: "ok" })
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
      model: "anthropic/claude-sonnet-4-20250514",
    })

    await wf.agent("general", "Hello")

    assert.equal(mockClient._promptCalls.length, 1)
    const body = mockClient._promptCalls[0]
    assert.deepEqual(body.model, {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-20250514",
    })

    wf.shutdown()
  })

  it("passes object model to SDK prompt body", { timeout: 10000 }, async () => {
    const mockClient = createMockClient({ responseText: "ok" })
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
      model: { providerID: "openai", modelID: "gpt-4o" },
    })

    await wf.agent("general", "Hello")

    const body = mockClient._promptCalls[0]
    assert.deepEqual(body.model, {
      providerID: "openai",
      modelID: "gpt-4o",
    })

    wf.shutdown()
  })

  it("per-agent model overrides workflow model", { timeout: 10000 }, async () => {
    const mockClient = createMockClient({ responseText: "ok" })
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
      model: "anthropic/claude-sonnet-4-20250514",
    })

    await wf.agent("general", "Hello", { model: "openai/gpt-4o" })

    const body = mockClient._promptCalls[0]
    assert.deepEqual(body.model, {
      providerID: "openai",
      modelID: "gpt-4o",
    })

    wf.shutdown()
  })

  it("omits model from body when no model configured", { timeout: 10000 }, async () => {
    const mockClient = createMockClient({ responseText: "ok" })
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
      // no model
    })

    await wf.agent("general", "Hello")

    const body = mockClient._promptCalls[0]
    assert.equal(body.model, undefined, "model should be absent when not configured")

    wf.shutdown()
  })

  it("passes model in parallel agents", { timeout: 10000 }, async () => {
    const mockClient = createMockClient({ responseText: "ok" })
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
      model: "anthropic/claude-sonnet-4-20250514",
    })

    await wf.parallel([
      { type: "general", prompt: "A" },
      { type: "general", prompt: "B", model: "openai/gpt-4o" },
    ])

    assert.equal(mockClient._promptCalls.length, 2)
    // First agent: inherits workflow model
    assert.deepEqual(mockClient._promptCalls[0].model, {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-20250514",
    })
    // Second agent: per-agent override
    assert.deepEqual(mockClient._promptCalls[1].model, {
      providerID: "openai",
      modelID: "gpt-4o",
    })

    wf.shutdown()
  })
})
