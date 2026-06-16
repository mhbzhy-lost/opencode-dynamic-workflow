/**
 * E2E tests — verify workflow orchestration against a real opencode server.
 *
 * Two test suites:
 *   1. Auto-serve: createWorkflow auto-starts a server (production path)
 *   2. Explicit baseUrl: workflow script connects to a pre-started server
 *
 * Prerequisites:
 *   - `opencode` binary in PATH
 *   - Valid model credentials configured
 *
 * These tests are SLOW (real LLM calls, ~20-120s each).
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"

const SUBMODULE_ROOT = resolve(new URL("..", import.meta.url).pathname)

/**
 * Start `opencode serve` on a random port, wait for it to be ready.
 * Returns { port, process, kill(), baseUrl }.
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", ["serve", "--port", "0", "--print-logs", "--log-level", "INFO"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    })

    let resolved = false
    const stderrBuf = []
    const stdoutBuf = []

    child.stdout.on("data", (d) => {
      stdoutBuf.push(d.toString())
      tryResolve()
    })
    child.stderr.on("data", (d) => {
      stderrBuf.push(d.toString())
      tryResolve()
    })

    function tryResolve() {
      if (resolved) return
      const all = stdoutBuf.join("") + stderrBuf.join("")
      // opencode serve prints the listening address when ready
      const match = all.match(/listening on (?:http:\/\/)?(\S+?):(\d+)/)
        || all.match(/server started.*?:(\d+)/)
        || all.match(/(?:address|port)\D+(\d{4,5})/)
      if (match) {
        const port = parseInt(match[match.length - 1], 10)
        resolved = true
        resolve({
          port,
          process: child,
          kill: () => { child.kill("SIGTERM") },
          baseUrl: `http://127.0.0.1:${port}`,
        })
      }
    }

    child.on("error", (err) => {
      if (!resolved) reject(new Error(`Failed to start opencode serve: ${err.message}`))
    })
    child.on("close", (code) => {
      if (!resolved) {
        reject(new Error(
          `opencode serve exited with code ${code} before becoming ready.\n` +
          `stdout: ${stdoutBuf.join("")}\nstderr: ${stderrBuf.join("")}`
        ))
      }
    })

    // Timeout: if server doesn't start in 30s, fail
    setTimeout(() => {
      if (!resolved) {
        child.kill("SIGTERM")
        reject(new Error(
          `opencode serve did not become ready within 30s.\n` +
          `stdout: ${stdoutBuf.join("")}\nstderr: ${stderrBuf.join("")}`
        ))
      }
    }, 30_000)
  })
}

/** Run a workflow script as a child process, return { code, stdout, stderr }. */
function runWorkflowScript(scriptPath, args = [], cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    })

    const stdoutChunks = []
    const stderrChunks = []

    child.stdout.on("data", (d) => stdoutChunks.push(d))
    child.stderr.on("data", (d) => stderrChunks.push(d))

    child.on("error", reject)
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Suite 1: SDK auto-serve (production path)
// ---------------------------------------------------------------------------

describe("e2e: auto-serve", () => {
  let projectDir

  before(() => {
    projectDir = mkdtempSync(join(tmpdir(), "wf-e2e-auto-"))
  })

  after(() => {
    try {
      rmSync(projectDir, { recursive: true, force: true })
    } catch {}
  })

  it(
    "single agent via auto-serve",
    { timeout: 120_000 },
    async () => {
      const { createWorkflow } = await import("../lib/runner.mjs")
      const workdir = join(projectDir, ".workflow")

      const wf = await createWorkflow({
        workdir,
        // no baseUrl → auto-starts server
      })

      const result = await wf.agent(
        "general",
        '回答两个字："你好"。不要输出其他任何内容。',
        { id: "auto-single" }
      )

      assert.equal(result.status, "completed", `agent failed: ${result.error}`)
      assert.ok(result.output, "output should not be empty")
      assert.ok(result.durationMs > 0, "durationMs should be positive")
      assert.equal(result.id, "auto-single")

      // IPC verification
      const statusPath = join(workdir, "status.json")
      assert.ok(existsSync(statusPath), "status.json should exist")
      const status = JSON.parse(readFileSync(statusPath, "utf8"))
      assert.ok(status.agents["auto-single"], "agent should be in status")
      assert.equal(status.agents["auto-single"].status, "completed")

      // Dashboard
      assert.ok(existsSync(join(workdir, "dashboard.html")), "dashboard.html should exist")

      wf.shutdown()  // also closes auto-started server
    }
  )
})

// ---------------------------------------------------------------------------
// Suite 2: Explicit baseUrl (connect to pre-started server)
// ---------------------------------------------------------------------------

describe("e2e: explicit baseUrl via opencode serve", () => {
  let server
  let projectDir

  before(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "wf-e2e-sdk-"))
    server = await startServer()
  })

  after(() => {
    server?.kill()
    try {
      rmSync(projectDir, { recursive: true, force: true })
    } catch {}
  })

  it(
    "single agent via explicit baseUrl",
    { timeout: 120_000 },
    async () => {
      const { createWorkflow } = await import("../lib/runner.mjs")
      const workdir = join(projectDir, ".workflow")

      const wf = await createWorkflow({
        workdir,
        baseUrl: server.baseUrl,
      })

      const result = await wf.agent(
        "general",
        '回答两个字："你好"。不要输出其他任何内容。',
        { id: "sdk-single" }
      )

      assert.equal(result.status, "completed", `agent failed: ${result.error}`)
      assert.ok(result.output, "output should not be empty")
      assert.ok(result.durationMs > 0, "durationMs should be positive")
      assert.equal(result.id, "sdk-single")

      // IPC verification
      const statusPath = join(workdir, "status.json")
      assert.ok(existsSync(statusPath), "status.json should exist")
      const status = JSON.parse(readFileSync(statusPath, "utf8"))
      assert.ok(status.agents["sdk-single"], "agent should be in status")
      assert.equal(status.agents["sdk-single"].status, "completed")

      // Dashboard
      assert.ok(existsSync(join(workdir, "dashboard.html")), "dashboard.html should exist")

      wf.shutdown()
    }
  )

  it(
    "parallel agents via explicit baseUrl",
    { timeout: 180_000 },
    async () => {
      const { createWorkflow } = await import("../lib/runner.mjs")
      const workdir2 = join(projectDir, ".workflow2")

      const wf = await createWorkflow({
        workdir: workdir2,
        baseUrl: server.baseUrl,
        maxConcurrent: 2,
      })

      const results = await wf.parallel([
        {
          type: "general",
          prompt: '回答两个字："苹果"。不要输出其他任何内容。',
          id: "sdk-p1",
        },
        {
          type: "general",
          prompt: '回答两个字："香蕉"。不要输出其他任何内容。',
          id: "sdk-p2",
        },
      ])

      assert.equal(results.length, 2)
      for (const r of results) {
        assert.equal(r.status, "completed", `agent ${r.id} failed: ${r.error}`)
        assert.ok(r.output, `agent ${r.id} output should not be empty`)
      }

      // Status check
      const status = JSON.parse(
        readFileSync(join(workdir2, "status.json"), "utf8")
      )
      assert.ok(status.agents["sdk-p1"])
      assert.ok(status.agents["sdk-p2"])

      wf.shutdown()
    }
  )
})

// ---------------------------------------------------------------------------
// Suite 3: Workflow script e2e (parallel-research.mjs subprocess)
// ---------------------------------------------------------------------------

describe("e2e: workflow script", () => {
  let server
  let projectDir

  before(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "wf-e2e-script-"))
    server = await startServer()
  })

  after(() => {
    server?.kill()
    try {
      rmSync(projectDir, { recursive: true, force: true })
    } catch {}
  })

  it(
    "parallel-research.mjs runs 2-phase workflow end-to-end",
    { timeout: 300_000 },
    async () => {
      const scriptPath = join(
        SUBMODULE_ROOT,
        "workflows",
        "parallel-research.mjs"
      )

      const { code, stdout, stderr } = await runWorkflowScript(
        scriptPath,
        [
          "--skip-permissions",
          "--base-url", server.baseUrl,
          "1+1等于几？只回答数字",
        ],
        projectDir
      )

      // ── 脚本退出码 ──
      assert.equal(code, 0, `script exited with code ${code}.\nstderr: ${stderr}`)

      // ── stderr 包含 dashboard 提示 ──
      assert.ok(
        stderr.includes("实时进度面板已就绪"),
        `stderr should contain dashboard hint. Got: ${stderr.slice(0, 300)}`
      )
      assert.ok(
        stderr.includes("open "),
        `stderr should contain 'open' command for dashboard`
      )

      // ── stdout 是合法 JSON 结果 ──
      // stdout 混合 [workflow:xxx] 事件行和最终 JSON 结果；提取非事件行
      const jsonLine = stdout
        .split("\n")
        .filter(line => !line.startsWith("[workflow:"))
        .join("\n")
        .trim()
      let result
      try {
        result = JSON.parse(jsonLine)
      } catch {
        assert.fail(`stdout JSON is not valid: ${jsonLine.slice(0, 500)}`)
      }
      assert.equal(result.type, "parallel-research")
      assert.equal(result.layers, 2)
      assert.equal(result.totalAgents, 4) // 3 research + 1 synthesis
      assert.ok(result.report, "report should not be empty")

      // ── IPC: .workflow/ 目录存在 ──
      const wfDir = join(projectDir, ".workflow")
      assert.ok(existsSync(wfDir), ".workflow/ directory should exist")

      // ── IPC: status.json 包含所有 4 个 agent ──
      const statusPath = join(wfDir, "status.json")
      assert.ok(existsSync(statusPath), "status.json should exist")
      const status = JSON.parse(readFileSync(statusPath, "utf8"))

      assert.equal(status.state, "completed") // shutdown() now explicitly marks workflow as completed
      assert.ok(status.agents["research-tech"], "agent research-tech should exist")
      assert.ok(status.agents["research-practices"], "agent research-practices should exist")
      assert.ok(status.agents["research-risks"], "agent research-risks should exist")
      assert.ok(status.agents["research-synthesis"], "agent research-synthesis should exist")

      // All agents should be completed
      for (const [id, agent] of Object.entries(status.agents)) {
        assert.equal(
          agent.status,
          "completed",
          `agent ${id} should be completed, got ${agent.status}`
        )
      }

      // ── IPC: dashboard.html 存在且包含 agent 信息 ──
      const dashPath = join(wfDir, "dashboard.html")
      assert.ok(existsSync(dashPath), "dashboard.html should exist")
      const dashHtml = readFileSync(dashPath, "utf8")
      assert.ok(dashHtml.includes("meta http-equiv"), "dashboard should have auto-refresh")
      assert.ok(dashHtml.includes("research-tech"), "dashboard should show agent IDs")

      // ── IPC: events/ 有事件文件 ──
      const eventsDir = join(wfDir, "events")
      assert.ok(existsSync(eventsDir), "events/ directory should exist")
      const eventFiles = readdirSync(eventsDir).filter((f) => f.endsWith(".json"))
      // 3 events from parallel phase (one per agent_completed), phase 2 single agent doesn't go through parallel
      assert.ok(eventFiles.length >= 3, `should have >= 3 events, got ${eventFiles.length}`)

      // ── IPC: result.json 存在（shutdown 写入）──
      const resultPath = join(wfDir, "result.json")
      assert.ok(existsSync(resultPath), "result.json should exist")

      // ── IPC: .gitignore 被写入 ──
      const gitignorePath = join(projectDir, ".gitignore")
      assert.ok(existsSync(gitignorePath), ".gitignore should be created")
      const gitignoreContent = readFileSync(gitignorePath, "utf8")
      assert.ok(
        gitignoreContent.includes(".workflow"),
        ".gitignore should contain .workflow"
      )
    }
  )
})
