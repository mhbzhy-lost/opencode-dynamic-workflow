import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

function createMockClient(options = {}) {
  return {
    global: { health: async () => ({ data: { healthy: true } }) },
    session: {
      create: async () => ({ data: { id: "ses_1" } }),
      prompt: async () => ({ data: { parts: [{ type: "text", text: options.responseText || "ok" }] } }),
      abort: async () => ({ data: {} }),
    },
  }
}

function createMockIpc() {
  const events = []
  const statuses = {}
  let state = "running"
  return {
    updateAgentStatus: (id, info) => { statuses[id] = { ...statuses[id], ...info } },
    updateState: (s) => { state = s },
    emitEvent: (e) => { events.push(e); return events.length },
    consumeCommands: () => [],
    writePid: () => {},
    readPid: () => null,
    writeSnapshot: () => {},
    readSnapshot: () => null,
    writeResult: () => {},
    readStatus: () => ({ state, agents: statuses }),
    _events: events,
    _statuses: statuses,
  }
}

describe("needPrompt idle-aware timeout", () => {
  let wf
  let tmpDir

  before(async () => {
    const { createWorkflow } = await import("../lib/runner.mjs")
    tmpDir = mkdtempSync(join(tmpdir(), "wf-idle-"))
    wf = await createWorkflow({
      _mockClient: createMockClient(),
      _mockIpc: createMockIpc(),
      commandsDir: tmpDir,
    })
  })

  after(() => {
    wf.shutdown()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("does NOT time out while sibling agents are still running", { timeout: 5000 }, async () => {
    const filePath = join(tmpDir, "agent_prompt_idle.json")
    
    const start = Date.now()
    const result = wf.needPrompt("idle", {}, {
      pollTimeoutMs: 300,
      getIdleInfo: () => ({
        pendingPrompts: 1,
        runningAgents: 1,  // 1 agent still running
        lastProgressAt: Date.now(),
      }),
    })

    await new Promise(r => setTimeout(r, 500))
    writeFileSync(filePath, JSON.stringify({ prompt: "arrived late" }))
    const prompt = await result
    const elapsed = Date.now() - start

    assert.equal(prompt, "arrived late")
    assert.ok(elapsed >= 500, `expected >=500ms, got ${elapsed}ms`)
  })

  it("times out only after ALL agents stop and timeout elapses", { timeout: 5000 }, async () => {
    const filePath = join(tmpDir, "agent_prompt_idle-fail.json")
    let runningAgents = 2
    let lastProgressAt = Date.now()

    const idleInfo = () => ({
      pendingPrompts: 1,
      runningAgents,
      lastProgressAt,
    })

    setTimeout(() => { runningAgents = 1; lastProgressAt = Date.now() }, 200)
    setTimeout(() => { runningAgents = 0; lastProgressAt = Date.now() }, 400)

    await assert.rejects(
      wf.needPrompt("idle-fail", {}, { pollTimeoutMs: 300, getIdleInfo: idleInfo }),
      /timeout|timed out/i
    )
    // timeout should be ~400ms (when agents stop) + ~300ms = ~700ms total
  })
})

describe("DAG layer: mixed needsPrompt + ready nodes", () => {
  let tmpDir

  it("ready nodes run while needsPrompt waits; timeout doesn't fire", { timeout: 15000 }, async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wf-dag-mixed-"))
    const { createWorkflow } = await import("../lib/runner.mjs")

    let promptCount = 0
    const slowClient = {
      global: { health: async () => ({ data: { healthy: true } }) },
      session: {
        create: async () => ({ data: { id: `ses_${++promptCount}` } }),
        prompt: async () => {
          await new Promise(r => setTimeout(r, 600))
          return { data: { parts: [{ type: "text", text: "agent done" }] } }
        },
        abort: async () => ({ data: {} }),
      },
    }

    const ipc = createMockIpc()
    const wf = await createWorkflow({
      _mockClient: slowClient,
      _mockIpc: ipc,
      commandsDir: tmpDir,
    })

    setTimeout(() => {
      writeFileSync(
        join(tmpDir, "agent_prompt_waiting-node.json"),
        JSON.stringify({ prompt: "injected prompt" })
      )
    }, 400)

    const results = await wf.dag([
      { id: "ready-node", type: "general", prompt: "run this task", deps: [] },
      { id: "waiting-node", type: "general", deps: [], needsPrompt: true },
      { id: "final-node", type: "general", prompt: "use: {{ready-node.output}} + {{waiting-node.output}}", deps: ["ready-node", "waiting-node"] },
    ])

    assert.equal(results["ready-node"].status, "completed")
    assert.equal(results["waiting-node"].status, "completed")
    assert.equal(results["final-node"].status, "completed")

    wf.shutdown()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
