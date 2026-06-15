import { resolve } from "node:path"
import { execFile } from "node:child_process"

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Parse model specification into { providerID, modelID } for SDK API.
 *
 * Accepts:
 *   - { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" }
 *   - "anthropic/claude-sonnet-4-20250514"   (provider/model string)
 *   - undefined (uses server default)
 *
 * Returns { providerID, modelID } | undefined
 */
function resolveModel(model) {
  if (!model) return undefined

  if (typeof model === "object" && model.providerID && model.modelID) {
    return { providerID: model.providerID, modelID: model.modelID }
  }

  if (typeof model === "string" && model.includes("/")) {
    const [providerID, ...rest] = model.split("/")
    const modelID = rest.join("/")
    return { providerID, modelID }
  }

  // Unrecognised format — cannot resolve, use server default
  return undefined
}

// ---------------------------------------------------------------------------
// Server lifecycle: auto-start opencode serve or connect to existing
// ---------------------------------------------------------------------------

/**
 * Start a local opencode server (if no baseUrl provided) or connect to existing.
 * Returns { client, closeServer } where closeServer() is a no-op when connecting
 * to an existing server.
 */
async function ensureServer(config) {
  // Mock path — tests inject their own client
  if (config._mockClient) {
    const client = config._mockClient
    if (client.global?.health) {
      const health = await client.global.health()
      if (health.data.healthy !== true) {
        throw new Error("Server health check failed")
      }
    }
    return { client, closeServer: () => {} }
  }

  const sdk = await import("@opencode-ai/sdk")

  // Explicit baseUrl → connect to existing server
  if (config.baseUrl) {
    const client = sdk.createOpencodeClient({ baseUrl: config.baseUrl })
    try {
      await client.session.list()
    } catch (err) {
      throw new Error(
        `Cannot connect to OpenCode server at ${config.baseUrl}. ` +
        `Ensure 'opencode serve --port <port>' is running. ` +
        `Original error: ${err.message}`
      )
    }
    return { client, closeServer: () => {} }
  }

  // Auto-start: createOpencodeServer picks a random port
  const server = await sdk.createOpencodeServer({
    port: 0,             // random available port
    hostname: "127.0.0.1",
  })

  const client = sdk.createOpencodeClient({ baseUrl: server.url })

  // Connectivity check
  try {
    await client.session.list()
  } catch (err) {
    server.close()
    throw new Error(
      `Auto-started server at ${server.url} but connectivity check failed: ${err.message}`
    )
  }

  return {
    client,
    closeServer: () => server.close(),
  }
}

// ---------------------------------------------------------------------------
// runAgent — executes a single agent via SDK session API
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
    const session = await client.session.create({
      body: { title: `${spec.type}: ${agentId}` },
    })
    // SDK returns { data: Session } where Session has .id
    const sessionId = session.data?.id ?? session.data
    const resolvedSessionId = typeof sessionId === "object" ? sessionId.id : sessionId

    ipc.updateAgentStatus(agentId, { sessionId: resolvedSessionId })

    // Resolve model: per-agent spec.model overrides workflow-level config.model
    const sdkModel = resolveModel(spec.model || config.model)

    const result = await client.session.prompt({
      path: { id: resolvedSessionId },
      body: {
        parts: [{ type: "text", text: spec.prompt }],
        ...(spec.type ? { agent: spec.type } : {}),
        ...(sdkModel ? { model: sdkModel } : {}),
      },
    })

    // SDK response: { data: { info: AssistantMessage, parts: Part[] } }
    // Mock response: { data: { parts: [{ type: "text", text }] } }
    const parts = result.data?.parts || []
    const output = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n")

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

/**
 * Create a workflow orchestrator.
 *
 * @param {object} config
 * @param {string} [config.baseUrl]        - URL of existing opencode server. If omitted,
 *                                           a local server is auto-started and stopped on shutdown.
 * @param {string} [config.model]          - Default model as "provider/model" or { providerID, modelID }.
 *                                           Individual agents can override via spec.model.
 * @param {string} [config.workdir]        - IPC directory (default: ".workflow")
 * @param {number} [config.maxConcurrent]  - Max parallel agents (default: 10)
 * @param {boolean} [config.resume]        - Resume from snapshot
 * @param {boolean} [config.openDashboard] - Auto-open dashboard in browser (default: true)
 * @param {object} [config._mockClient]    - Injected mock client (testing)
 * @param {object} [config._mockIpc]       - Injected mock IPC (testing)
 */
export async function createWorkflow(config = {}) {
  const workdir = config.workdir || ".workflow"
  const maxConcurrent = config.maxConcurrent || 10
  const resumeMode = config.resume || false
  const model = config.model || undefined

  // Server lifecycle: auto-start or connect to existing
  const { client, closeServer } = await ensureServer(config)

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

  // Auto-open dashboard (default: true, skip in test/mock environments)
  if (config.openDashboard !== false && !config._mockClient && !config._mockIpc) {
    execFile("open", [dashboardPath], (err) => {
      if (err) console.error(`[workflow] dashboard 自动打开失败: ${err.message}`)
    })
  }

  // Resolved config for runAgent
  const resolvedConfig = { ...config, maxConcurrent, model }

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
      closeServer()
    },
  }
}
