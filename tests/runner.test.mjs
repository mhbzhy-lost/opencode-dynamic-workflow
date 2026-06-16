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

  it("writes output to IPC status on success", { timeout: 10000 }, async () => {
    const mockClient = createMockClient({ responseText: "hello world" })
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
    })

    await wf.agent("coder", "Write hello world", { id: "ipc-output-test" })

    const agentStatus = mockIpc._statuses["ipc-output-test"]
    assert.equal(agentStatus.status, "completed")
    assert.equal(agentStatus.output, "hello world", "IPC status should contain output")

    wf.shutdown()
  })

  it("writes error to IPC status on failure", { timeout: 10000 }, async () => {
    const mockClient = createMockClient({
      shouldFail: true,
      failMessage: "boom",
    })
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
    })

    await wf.agent("coder", "Do something", { id: "ipc-error-test" })

    const agentStatus = mockIpc._statuses["ipc-error-test"]
    assert.equal(agentStatus.status, "failed")
    assert.equal(agentStatus.error, "boom", "IPC status should contain error")

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

describe("wf.dag()", () => {
  it("executes a 2-layer DAG in correct order", { timeout: 10000 }, async () => {
    const mockClient = createMockClient({ responseText: "ok" })
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
    })

    const results = await wf.dag([
      { id: "a", type: "coder", prompt: "Task A", deps: [] },
      { id: "b", type: "coder", prompt: "Task B", deps: [] },
      { id: "c", type: "coder", prompt: "Task C", deps: ["a", "b"] },
    ])

    assert.equal(Object.keys(results).length, 3)
    assert.equal(results.a.status, "completed")
    assert.equal(results.b.status, "completed")
    assert.equal(results.c.status, "completed")

    wf.shutdown()
  })

  it("interpolates upstream outputs into dependent prompts", { timeout: 10000 }, async () => {
    const prompts = []
    const mockClient = {
      global: { health: async () => ({ data: { healthy: true } }) },
      session: {
        list: async () => ({ data: [] }),
        create: async (opts) => ({ data: { id: `s-${Math.random()}` } }),
        prompt: async (opts) => {
          prompts.push({ id: opts.path.id, text: opts.body.parts[0].text })
          const text = opts.body.parts[0].text
          return { data: { parts: [{ type: "text", text: `response to: ${text}` }] } }
        },
      },
    }
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
    })

    const results = await wf.dag([
      { id: "research", type: "coder", prompt: "Find details about X", deps: [] },
      { id: "summary", type: "coder", prompt: "Summarize: {{research.output}}", deps: ["research"] },
    ])

    // The second agent's prompt should contain the first agent's output
    const summaryPrompt = prompts.find(p => {
      const text = p.text
      return text.includes("Summarize: response to:")
    })
    assert.ok(summaryPrompt, "summary agent should have interpolated prompt")

    wf.shutdown()
  })

  it("handles 3-layer diamond dependency", { timeout: 10000 }, async () => {
    const executionOrder = []
    const mockClient = {
      global: { health: async () => ({ data: { healthy: true } }) },
      session: {
        list: async () => ({ data: [] }),
        create: async (opts) => ({ data: { id: `s-${Math.random()}` } }),
        prompt: async (opts) => {
          const text = opts.body.parts[0].text
          executionOrder.push(text)
          return { data: { parts: [{ type: "text", text: `done: ${text}` }] } }
        },
      },
    }
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
    })

    // Diamond: A → (B, C) → D
    const results = await wf.dag([
      { id: "A", type: "coder", prompt: "A", deps: [] },
      { id: "B", type: "coder", prompt: "B", deps: ["A"] },
      { id: "C", type: "coder", prompt: "C", deps: ["A"] },
      { id: "D", type: "coder", prompt: "D from {{B.output}} + {{C.output}}", deps: ["B", "C"] },
    ])

    assert.equal(results.A.status, "completed")
    assert.equal(results.B.status, "completed")
    assert.equal(results.C.status, "completed")
    assert.equal(results.D.status, "completed")
    // D's prompt should contain interpolated outputs from B and C
    assert.ok(results.D.output.includes("done: B"))
    assert.ok(results.D.output.includes("done: C"))

    wf.shutdown()
  })

  it("interpolates prompts safely when dep ids contain regex metacharacters", { timeout: 10000 }, async () => {
    const prompts = []
    const mockClient = {
      global: { health: async () => ({ data: { healthy: true } }) },
      session: {
        list: async () => ({ data: [] }),
        create: async (opts) => ({ data: { id: `s-${Math.random()}` } }),
        prompt: async (opts) => {
          const text = opts.body.parts[0].text
          prompts.push(text)
          return { data: { parts: [{ type: "text", text: `out-for-${text}` }] } }
        },
      },
    }
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
    })

    // Dep id with `.` regex metachar — must be treated as literal dot.
    // With `new RegExp`, `.` matches any single char. The decoy
    // `{{feat branch.output}}` (with a SPACE) would be wrongly matched
    // by a regex, and the result would replace the space-bearing version.
    const results = await wf.dag([
      { id: "feat.branch", type: "coder", prompt: "do feat.branch work", deps: [] },
      {
        id: "downstream",
        type: "coder",
        // The decoy `{{feat branch.output}}` MUST remain untouched;
        // only `{{feat.branch.output}}` (literal dot) should be interpolated.
        prompt: "decoy {{feat branch.output}} vs real {{feat.branch.output}}",
        deps: ["feat.branch"],
      },
    ])

    assert.equal(results["feat.branch"].status, "completed")
    assert.equal(results.downstream.status, "completed")
    const downstreamPrompt = prompts[prompts.length - 1]
    assert.ok(
      downstreamPrompt.includes("decoy {{feat branch.output}}"),
      `decoy must remain untouched (literal matching preserves it); got: ${downstreamPrompt}`
    )
    assert.ok(
      downstreamPrompt.includes("out-for-do feat.branch work"),
      "placeholder must be substituted with upstream output"
    )
    assert.ok(
      !downstreamPrompt.includes("{{feat.branch.output}}"),
      "no unresolved placeholder remaining"
    )

    wf.shutdown()
  })
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
    // The abort command should still be unconsumed (state is "completed" from shutdown, not "running")
    assert.equal(mockIpc._state(), "completed")
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

// ---------------------------------------------------------------------------
// dashboard timer error handling
// ---------------------------------------------------------------------------

describe("dashboard refresh error handling", () => {
  it("logs first render error, stays silent on subsequent", { timeout: 10000 }, async () => {
    const mockClient = createMockClient({ responseText: "ok" })

    let renderCallCount = 0
    const mockIpc = createMockIpc()
    mockIpc.readStatus = () => ({ state: "running", agents: mockIpc._statuses })

    const origStderr = process.stderr.write.bind(process.stderr)
    const stderrChunks = []
    process.stderr.write = (chunk, ...rest) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString())
      return true
    }

    try {
      const { createWorkflow } = await import("../lib/runner.mjs")

      const origImport = await import("../lib/dashboard.mjs")
      const origRender = origImport.renderDashboard
      let patchedModule = false

      const wf = await createWorkflow({
        _mockClient: mockClient,
        _mockIpc: mockIpc,
        _dashboardRender: () => {
          renderCallCount++
          throw new Error("render boom")
        },
      })

      await new Promise((r) => setTimeout(r, 2500))

      wf.shutdown()

      const stderrOutput = stderrChunks.join("")
      const matches = stderrOutput.match(/dashboard refresh failed/g) || []
      assert.ok(renderCallCount >= 2, `render should be called at least twice, got ${renderCallCount}`)
      assert.equal(matches.length, 1, `only first error logged, found ${matches.length} log lines`)
      assert.ok(stderrOutput.includes("render boom"), "error message should be included")
    } finally {
      process.stderr.write = origStderr
    }
  })
})

// ---------------------------------------------------------------------------
// worktree integration
// ---------------------------------------------------------------------------

describe("worktree integration", () => {
  it("wf.worktree is undefined when worktree config is absent", { timeout: 10000 }, async () => {
    const mockClient = createMockClient()
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
    })

    assert.equal(wf.worktree, undefined)
    wf.shutdown()
  })

  it("creates a worktree and exposes it on wf.worktree when enabled + mocked", { timeout: 10000 }, async () => {
    const execCalls = []
    const mockExec = (cmd, args) => {
      execCalls.push([cmd, args])
      return Promise.resolve("")
    }

    const mockClient = createMockClient()
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
      worktree: {
        enable: true,
        repoDir: "/tmp/repo",
        branch: "wf-test-001",
        baseBranch: "main",
        exec: mockExec,
      },
    })

    assert.ok(wf.worktree, "wf.worktree should be set")
    assert.equal(wf.worktree.branch, "wf-test-001")
    assert.equal(wf.worktree.repoDir, "/tmp/repo")
    assert.ok(wf.worktree.path.endsWith("/.workflow/wf-test-001"))

    // git worktree add was actually called
    assert.ok(execCalls.some(([, args]) => args[0] === "-C" && args.includes("worktree") && args.includes("add")))

    wf.shutdown()
  })

  it("skips worktree creation when baseUrl is provided", { timeout: 10000 }, async () => {
    const execCalls = []
    const mockExec = (cmd, args) => {
      execCalls.push([cmd, args])
      return Promise.resolve("")
    }
    const mockClient = createMockClient()
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
      baseUrl: "http://127.0.0.1:1234", // user already has a server
      worktree: {
        enable: true,
        repoDir: "/tmp/repo",
        branch: "wf-test-002",
        baseBranch: "main",
        exec: mockExec,
      },
    })

    assert.equal(wf.worktree, undefined, "baseUrl overrides local worktree creation")
    assert.equal(execCalls.length, 0, "no git commands issued when baseUrl is set")

    wf.shutdown()
  })

  it("shutdown writes worktree info to IPC result", { timeout: 10000 }, async () => {
    const mockExec = () => Promise.resolve("")
    const mockClient = createMockClient()
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
      worktree: {
        enable: true,
        repoDir: "/tmp/repo",
        branch: "wf-test-003",
        baseBranch: "main",
        exec: mockExec,
      },
    })

    wf.shutdown()

    const result = mockIpc._result()
    assert.ok(result, "result should be written on shutdown")
    assert.ok(result.worktree, "result should include worktree info")
    assert.equal(result.worktree.branch, "wf-test-003")
  })

  it("shutdown does NOT auto-remove the worktree (main agent merges it)", { timeout: 10000 }, async () => {
    const execCalls = []
    const mockExec = (cmd, args) => {
      execCalls.push([cmd, args])
      return Promise.resolve("")
    }
    const mockClient = createMockClient()
    const mockIpc = createMockIpc()
    const { createWorkflow } = await import("../lib/runner.mjs")

    const wf = await createWorkflow({
      _mockClient: mockClient,
      _mockIpc: mockIpc,
      worktree: {
        enable: true,
        repoDir: "/tmp/repo",
        branch: "wf-test-004",
        baseBranch: "main",
        exec: mockExec,
      },
    })

    wf.shutdown()

    // Should only have seen the initial add; no "remove" in execCalls
    const removeCalls = execCalls.filter(
      ([, args]) => args.includes("remove")
    )
    assert.equal(removeCalls.length, 0, "worktree is NOT auto-removed")
  })
})
