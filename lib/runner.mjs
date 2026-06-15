import { resolve } from "node:path"
import { spawn } from "node:child_process"

// ---------------------------------------------------------------------------
// Backend: SDK (for opencode serve / mock testing)
// ---------------------------------------------------------------------------

async function connectToServer(baseUrl, _mockClient) {
  if (_mockClient) return _mockClient

  const { createOpencodeClient } = await import("@opencode-ai/sdk")
  const client = createOpencodeClient({ baseUrl })
  // SDK has no global.health() — use session.list() as a connectivity check
  try {
    await client.session.list()
  } catch (err) {
    throw new Error(
      `Cannot connect to OpenCode server at ${baseUrl}. ` +
      `Ensure 'opencode serve --port <port>' is running. ` +
      `Original error: ${err.message}`
    )
  }
  return client
}

// ---------------------------------------------------------------------------
// Backend: CLI (opencode run subprocess — works with TUI, no server needed)
// ---------------------------------------------------------------------------

function runViaCli(cliPath, prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ["run"]

    if (opts.agent) args.push("--agent", opts.agent)
    if (opts.model) args.push("--model", opts.model)
    if (opts.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions")
    args.push("--format", "json")
    args.push("--", prompt)

    const child = spawn(cliPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    })

    const chunks = []
    const stderrChunks = []

    child.stdout.on("data", (d) => chunks.push(d))
    child.stderr.on("data", (d) => stderrChunks.push(d))

    child.on("error", (err) =>
      reject(new Error(`Failed to spawn ${cliPath}: ${err.message}`))
    )

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8")
      const stderr = Buffer.concat(stderrChunks).toString("utf8")

      if (code !== 0) {
        reject(
          new Error(
            `opencode run exited with code ${code}. stderr: ${stderr.slice(0, 500)}`
          )
        )
        return
      }

      // --format json outputs newline-delimited JSON events.
      // Extract text from assistant message events.
      const output = extractOutputFromJsonEvents(stdout)
      resolve(output)
    })
  })
}

/**
 * Parse `opencode run --format json` output.
 * Each line is a JSON event. We want the text content from assistant messages.
 */
function extractOutputFromJsonEvents(raw) {
  const lines = raw.split("\n").filter((l) => l.trim())
  const texts = []

  for (const line of lines) {
    try {
      const event = JSON.parse(line)

      // Event shapes vary; try common patterns:
      // 1. { type: "text", text: "..." }
      if (event.type === "text" && event.text) {
        texts.push(event.text)
        continue
      }
      // 2. { role: "assistant", parts: [{ type: "text", text: "..." }] }
      if (event.role === "assistant" && Array.isArray(event.parts)) {
        for (const p of event.parts) {
          if (p.type === "text" && p.text) texts.push(p.text)
        }
        continue
      }
      // 3. { content: "..." } or { message: { content: "..." } }
      if (typeof event.content === "string") {
        texts.push(event.content)
        continue
      }
      if (event.message?.content) {
        texts.push(event.message.content)
        continue
      }
      // 4. { part: { type: "text", text: "..." } }
      if (event.part?.type === "text" && event.part.text) {
        texts.push(event.part.text)
        continue
      }
    } catch {
      // non-JSON line, skip
    }
  }

  return texts.join("") || raw.trim()
}

// ---------------------------------------------------------------------------
// runAgent — dispatches to the selected backend
// ---------------------------------------------------------------------------

async function runAgent(client, spec, ipc, config) {
  const agentId =
    spec.id || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const startedAt = Date.now()

  ipc.updateAgentStatus(agentId, {
    type: spec.type,
    status: "running",
    prompt: spec.prompt,
    startedAt,
  })

  try {
    let output

    if (config.backend === "cli") {
      // CLI backend: opencode run subprocess
      output = await runViaCli(config.cliPath || "opencode", spec.prompt, {
        agent: spec.type,
        model: spec.model,
        dangerouslySkipPermissions: config.dangerouslySkipPermissions,
      })
    } else {
      // SDK / mock backend
      const session = await client.session.create({
        body: { title: `${spec.type}: ${agentId}` },
      })
      // SDK returns { data: Session } where Session has .id
      const sessionId = session.data?.id ?? session.data
      const resolvedSessionId = typeof sessionId === "object" ? sessionId.id : sessionId

      ipc.updateAgentStatus(agentId, { sessionId: resolvedSessionId })

      const result = await client.session.prompt({
        path: { id: resolvedSessionId },
        body: {
          parts: [{ type: "text", text: spec.prompt }],
          ...(spec.type ? { agent: spec.type } : {}),
        },
      })

      // SDK response: { data: { info: AssistantMessage, parts: Part[] } }
      // Mock response: { data: { parts: [{ type: "text", text }] } }
      const parts = result.data?.parts || []
      output = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
    }

    const durationMs = Date.now() - startedAt

    ipc.updateAgentStatus(agentId, {
      status: "completed",
      durationMs,
    })

    return { id: agentId, status: "completed", output, durationMs }
  } catch (err) {
    const durationMs = Date.now() - startedAt

    ipc.updateAgentStatus(agentId, {
      status: "failed",
      error: err.message,
      durationMs,
    })

    return { id: agentId, status: "failed", error: err.message, durationMs }
  }
}

// ---------------------------------------------------------------------------
// runParallel
// ---------------------------------------------------------------------------

async function runParallel(client, specs, ipc, config) {
  const maxConcurrent = config.maxConcurrent || 10
  const results = new Array(specs.length)
  const queue = specs.map((s, i) => ({ spec: s, index: i }))
  const running = new Set()

  return new Promise((resolveAll) => {
    function tryFill() {
      while (running.size < maxConcurrent && queue.length > 0) {
        const item = queue.shift()
        const p = runAgent(client, item.spec, ipc, config).then((result) => {
          results[item.index] = result
          running.delete(p)
          ipc.emitEvent({
            type: "agent_completed",
            agentId: result.id,
            status: result.status,
          })
          tryFill()
          if (running.size === 0 && queue.length === 0) {
            resolveAll(results)
          }
        })
        running.add(p)
      }
      // Edge case: no specs at all
      if (running.size === 0 && queue.length === 0) {
        resolveAll(results)
      }
    }
    tryFill()
  })
}

// ---------------------------------------------------------------------------
// Command processing
// ---------------------------------------------------------------------------

function processCommands(commands, state, client, ipc) {
  for (const cmd of commands) {
    switch (cmd.type) {
      case "stop": {
        const status = ipc.readStatus()
        const agentInfo = status?.agents?.[cmd.agentId]
        if (agentInfo && agentInfo.sessionId && client?.session?.abort) {
          client.session
            .abort({ path: { id: agentInfo.sessionId } })
            .catch(() => {})
        }
        ipc.updateAgentStatus(cmd.agentId, { status: "stopped" })
        break
      }
      case "abort": {
        const status = ipc.readStatus()
        if (status?.agents) {
          for (const [id, info] of Object.entries(status.agents)) {
            if (info.status === "running" && info.sessionId && client?.session?.abort) {
              client.session
                .abort({ path: { id: info.sessionId } })
                .catch(() => {})
            }
            if (info.status === "running") {
              ipc.updateAgentStatus(id, { status: "stopped" })
            }
          }
        }
        ipc.updateState("aborted")
        state.aborted = true
        break
      }
      case "pause": {
        ipc.updateState("paused")
        ipc.writeSnapshot(state.snapshotData || {})
        state.paused = true
        break
      }
      case "resume": {
        ipc.updateState("running")
        state.paused = false
        break
      }
      case "spawn": {
        if (state.spawnQueue) {
          state.spawnQueue.push(cmd.spec)
        }
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// createWorkflow
// ---------------------------------------------------------------------------

export async function createWorkflow(config = {}) {
  const baseUrl = config.baseUrl || "http://127.0.0.1:4096"
  const workdir = config.workdir || ".workflow"
  const maxConcurrent = config.maxConcurrent || 10
  const resumeMode = config.resume || false
  const backend = config.backend || "sdk"  // "sdk" | "cli"

  // Connect (or use mock) — only needed for SDK backend
  let client = null
  if (config._mockClient) {
    client = config._mockClient
    // Mock clients may provide global.health() or session.list() for health check
    if (client.global?.health) {
      const health = await client.global.health()
      if (health.data.healthy !== true) {
        throw new Error("Server health check failed")
      }
    }
  } else if (backend === "sdk") {
    client = await connectToServer(baseUrl)
  }
  // CLI backend doesn't need a persistent client connection

  // IPC
  const ipc = config._mockIpc || (await import("./ipc.mjs")).createIpc(workdir)

  // State
  const state = {
    paused: false,
    aborted: false,
    snapshotData: null,
    spawnQueue: [],
  }

  // Resume: load snapshot if available
  let snapshot = null
  if (resumeMode) {
    snapshot = ipc.readSnapshot()
    state.snapshotData = snapshot
  }

  ipc.updateState("running")

  // Command consumption loop
  const cmdInterval = setInterval(() => {
    try {
      const commands = ipc.consumeCommands()
      if (commands.length > 0) {
        processCommands(commands, state, client, ipc)
      }
    } catch (_) {
      // ignore errors in command processing
    }
  }, 1000)

  // Unref the interval so it doesn't prevent process exit in tests
  if (cmdInterval.unref) cmdInterval.unref()

  const dashboardPath = resolve(workdir, "dashboard.html")

  // Merge config with resolved values for runAgent
  const resolvedConfig = { ...config, maxConcurrent, backend }

  return {
    agent: async (type, prompt, opts = {}) => {
      const spec = { type, prompt, ...opts }
      return runAgent(client, spec, ipc, resolvedConfig)
    },

    parallel: async (specs) => {
      return runParallel(client, specs, ipc, resolvedConfig)
    },

    status: () => {
      return ipc.readStatus()
    },

    dashboardPath,

    snapshot,

    shutdown: () => {
      clearInterval(cmdInterval)
      ipc.writeResult({ completedAt: Date.now() })
    },
  }
}
