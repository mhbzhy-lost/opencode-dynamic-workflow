import { describe, it, before, after, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// ---------------------------------------------------------------------------
// Mock helpers (duplicated from runner.test.mjs to keep this file standalone)
// ---------------------------------------------------------------------------

function createMockClient() {
  return {
    global: { health: async () => ({ data: { healthy: true } }) },
    session: {
      create: async ({ body }) => ({ data: { id: "ses_1" } }),
      prompt: async () => ({ data: { parts: [{ type: "text", text: "ok" }] } }),
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
    _state: () => state,
  }
}

// ---------------------------------------------------------------------------
// Capture stdout writes during a test
// ---------------------------------------------------------------------------

function captureStdout() {
  const lines = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => {
    lines.push(typeof chunk === "string" ? chunk : chunk.toString())
    return orig(chunk, ...rest)
  }
  return {
    lines,
    restore() { process.stdout.write = orig },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wf.readPrompt()", () => {
  let tmpDir
  let wf
  let cap

  before(async () => {
    const { createWorkflow } = await import("../lib/runner.mjs")
    tmpDir = mkdtempSync(join(tmpdir(), "wf-needprompt-"))
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

  it("returns null when prompt file does not exist", { timeout: 5000 }, () => {
    const result = wf.readPrompt("missing-id-xyz")
    assert.equal(result, null)
  })

  it("returns prompt string when file exists", { timeout: 5000 }, () => {
    writeFileSync(
      join(tmpDir, "agent_prompt_exists.json"),
      JSON.stringify({ prompt: "Please do the thing" })
    )
    const result = wf.readPrompt("exists")
    assert.equal(result, "Please do the thing")
  })

  it("returns null for malformed JSON file (no clear error)", { timeout: 5000 }, () => {
    writeFileSync(join(tmpDir, "agent_prompt_badjson.json"), "not json at all")
    const result = wf.readPrompt("badjson")
    assert.equal(result, null)
  })
})

describe("wf.needPrompt()", () => {
  let tmpDir
  let wf

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wf-needprompt-"))
    const { createWorkflow } = await import("../lib/runner.mjs")
    wf = await createWorkflow({
      _mockClient: createMockClient(),
      _mockIpc: createMockIpc(),
      commandsDir: tmpDir,
    })
  })

  afterEach(() => {
    wf.shutdown()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("emits [workflow:need_prompt] JSON line to stdout", { timeout: 5000 }, async () => {
    // Write the file immediately so needPrompt doesn't block
    writeFileSync(
      join(tmpDir, "agent_prompt_emit-test.json"),
      JSON.stringify({ prompt: "hello" })
    )

    const cap = captureStdout()
    try {
      await wf.needPrompt("emit-test", { type: "coder" })
    } finally {
      cap.restore()
    }

    const emitted = cap.lines.find((l) => l.includes("[workflow:need_prompt]"))
    assert.ok(emitted, `Expected [workflow:need_prompt] line in stdout, got: ${JSON.stringify(cap.lines)}`)

    const json = JSON.parse(emitted.replace("[workflow:need_prompt] ", "").trim())
    assert.equal(json.id, "emit-test")
    assert.deepEqual(json.spec, { type: "coder" })
  })

  it("blocks until command file appears, then returns prompt", { timeout: 10000 }, async () => {
    const filePromise = new Promise((resolve) => {
      setTimeout(() => {
        writeFileSync(
          join(tmpDir, "agent_prompt_block-test.json"),
          JSON.stringify({ prompt: "delayed prompt" })
        )
        resolve()
      }, 150)
    })

    const resultPromise = wf.needPrompt("block-test", {})
    await filePromise
    const result = await resultPromise

    assert.equal(result, "delayed prompt")
  })

  it("throws clear error on malformed JSON in command file", { timeout: 5000 }, async () => {
    writeFileSync(
      join(tmpDir, "agent_prompt_bad.json"),
      "not json {{{"
    )

    await assert.rejects(
      () => wf.needPrompt("bad", {}),
      (err) => {
        assert.ok(err instanceof Error)
        assert.ok(
          /JSON|parse|malformed|invalid/i.test(err.message),
          `Expected error mentioning JSON/parse, got: ${err.message}`
        )
        return true
      }
    )
  })

  it("returns prompt synchronously without polling when file already exists", { timeout: 5000 }, async () => {
    writeFileSync(
      join(tmpDir, "agent_prompt_immediate.json"),
      JSON.stringify({ prompt: "already here" })
    )

    const start = Date.now()
    const result = await wf.needPrompt("immediate", {})
    const elapsed = Date.now() - start

    assert.equal(result, "already here")
    assert.ok(elapsed < 100, `took ${elapsed}ms, expected <100ms`)
  })
})
