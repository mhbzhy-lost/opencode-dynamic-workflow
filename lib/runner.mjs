import { resolve, join } from "node:path"
import { execFile, execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { emitEvent } from "./events.mjs"

// ---------------------------------------------------------------------------
// Config resolution helper
//
// Agent-written workflow scripts almost always need the same boilerplate:
// CLI flag parsing for --model / --workdir / --resume / etc., plus safe
// defaults for openDashboard (closed) and dangerouslySkipPermissions (on).
//
// resolveWorkflowConfig(args, userDefaults) collapses that boilerplate into
// a single call. Returns a config object that can be passed directly to
// createWorkflow(). Positional (non-flag) args land on .positional.
//
// Precedence (highest → lowest):
//   CLI flag → userDefaults → hard-coded defaults
//
// Hard-coded defaults:
//   openDashboard: false        (dashboard auto-open blocks headless runs)
//   dangerouslySkipPermissions: true  (workflow-driven runs already have consent)
//   maxConcurrent: 4            (conservative parallelism)
// ---------------------------------------------------------------------------

const HARD_DEFAULTS = {
  openDashboard: false,
  dangerouslySkipPermissions: true,
  maxConcurrent: 4,
}

export function resolveWorkflowConfig(args = [], userDefaults = {}) {
  const result = { ...HARD_DEFAULTS, ...userDefaults }
  const positional = []

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const nextArg = () => {
      const next = args[i + 1]
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`missing value for ${a}`)
      }
      i++
      return next
    }
    switch (a) {
      case "--model":             result.model = nextArg(); break
      case "--base-url":          result.baseUrl = nextArg(); break
      case "--workdir":           result.workdir = nextArg(); break
      case "--max-concurrent":    result.maxConcurrent = Number(nextArg()); break
      case "--no-dashboard":      result.openDashboard = false; break
      case "--dashboard":         result.openDashboard = true; break
      case "--skip-permissions":  result.dangerouslySkipPermissions = true; break
      case "--no-skip-permissions": result.dangerouslySkipPermissions = false; break
      case "--resume":            result.resume = true; break
      default:                    positional.push(a); break
    }
  }

  result.positional = positional
  return result
}

// ---------------------------------------------------------------------------
// Prompt I/O  (main-agent ↔ workflow handshake via {commandsDir}/agent_prompt_<id>.json)
//
// - readPrompt(id)           : sync read, returns prompt string || null
// - needPrompt(id, spec)     : async — emits [workflow:need_prompt] JSON line,
//                              polls until the command file appears, returns prompt
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 200
const POLL_TIMEOUT_MS  = 300_000  // 300s: only counts when ALL agents idle (see getIdleInfo)

function promptFilePath(commandsDir, id) {
  return join(commandsDir, `agent_prompt_${id}.json`)
}

function readPrompt(commandsDir, id) {
  const path = promptFilePath(commandsDir, id)
  if (!existsSync(path)) return null
  let raw
  try {
    raw = readFileSync(path, "utf8")
  } catch (e) {
    // Distinguish "not yet available" from "permanently broken".
    // ENOENT between existsSync and readFileSync is a rare race window,
    // treat as "not ready". All other read errors (permissions, EIO)
    // propagate so permanent corruption isn't silently hid.
    if (e && e.code === "ENOENT") return null
    throw e
  }
  try {
    const obj = JSON.parse(raw)
    return typeof obj.prompt === "string" ? obj.prompt : null
  } catch (e) {
    // Sync API: can't retry. Return null so callers polling can treat
    // it as "not ready yet" and retry on next tick. Callers that need
    // clear failure semantics should use needPrompt (async, with retry).
    return null
  }
}

async function needPrompt(commandsDir, id, spec = {}, opts = {}) {
  emitEvent("need_agent", { id, spec })

  const path = promptFilePath(commandsDir, id)
  const timeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS
  const intervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS

  let idleStartedAt = null  // when all agents stopped running and no file appeared

  while (true) {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8")
      let obj
      try {
        obj = JSON.parse(raw)
      } catch {
        if (!opts.getIdleInfo || opts.getIdleInfo().runningAgents === 0) {
          if (idleStartedAt === null) idleStartedAt = Date.now()
          if (Date.now() - idleStartedAt > timeoutMs) {
            throw new Error(
              `Timed out after ${timeoutMs}ms waiting for valid JSON in ${path}`
            )
          }
        } else {
          idleStartedAt = null
        }
        await new Promise((r) => setTimeout(r, intervalMs))
        continue
      }
      if (typeof obj.prompt !== "string") {
        if (!opts.getIdleInfo || opts.getIdleInfo().runningAgents === 0) {
          if (idleStartedAt === null) idleStartedAt = Date.now()
          if (Date.now() - idleStartedAt > timeoutMs) {
            throw new Error(
              `Timed out after ${timeoutMs}ms: ${path} has no "prompt" string field`
            )
          }
        } else {
          idleStartedAt = null
        }
        await new Promise((r) => setTimeout(r, intervalMs))
        continue
      }
      return obj.prompt
    }

    // File doesn't exist yet. Check idle info to decide whether to timeout.
    const info = opts.getIdleInfo?.()
    if (info && info.runningAgents > 0) {
      // Siblings still running — don't timeout, just wait
      idleStartedAt = null
    } else {
      // All agents idle (or no idle info, legacy path) — start idle timer
      if (idleStartedAt === null) idleStartedAt = Date.now()
      const idleDur = Date.now() - idleStartedAt
      if (idleDur > timeoutMs) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for ${path}`
        )
      }
    }

    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

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

// opencode only recognises `build` / `plan` as built-in agents
// (verified with opencode 1.17.x). Workflow role labels like
// `coder` / `explore` / `general` are metadata — passing them as
// `agent:` causes the server to raise UnknownError. Only forward
// values opencode knows about; drop everything else so the server
// falls back to its default `build` agent.
function resolveAgent(specType) {
  if (specType === "build" || specType === "plan") return specType
  return undefined
}

async function runAgent(client, spec, ipc, config, options = {}) {
  const agentId =
    spec.id || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const startedAt = Date.now()

  const resolvedAgent = resolveAgent(spec.type)

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
      ...(options.directory ? { query: { directory: options.directory } } : {}),
      path: { id: resolvedSessionId },
      body: {
        parts: [{ type: "text", text: spec.prompt }],
        ...(resolvedAgent ? { agent: resolvedAgent } : {}),
        ...(sdkModel ? { model: sdkModel } : {}),
      },
    })

    // SDK error path: hey-api returns { error: {...}, request, response }
    // (no `data`) for non-2xx or server-side failures. The prompt was
    // rejected — surface this as a failure rather than silent success.
    if (result.error) {
      const errData = result.error?.data || result.error
      const msg =
        errData?.message ||
        errData?.name ||
        JSON.stringify(result.error).slice(0, 200)
      throw new Error(`session.prompt failed: ${msg}`)
    }

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
      output,
      finishedAt: Date.now(),
      durationMs,
    })

    return { id: agentId, status: "completed", output, durationMs }
  } catch (err) {
    const durationMs = Date.now() - startedAt

    ipc.updateAgentStatus(agentId, {
      status: "failed",
      error: err.message,
      finishedAt: Date.now(),
      durationMs,
    })

    return { id: agentId, status: "failed", error: err.message, durationMs }
  }
}

// ---------------------------------------------------------------------------
// runParallel
// ---------------------------------------------------------------------------

async function runParallel(client, specs, ipc, config, progress) {
  const maxConcurrent = config.maxConcurrent || 10
  const results = new Array(specs.length)
  const queue = specs.map((s, i) => ({ spec: s, index: i }))
  const running = new Set()

  return new Promise((resolveAll) => {
    function tryFill() {
      while (running.size < maxConcurrent && queue.length > 0) {
        const item = queue.shift()
        const agentOptions = item.spec.directory ? { directory: item.spec.directory } : {}
        if (progress) {
          progress.runningAgents++
          progress.lastProgressAt = Date.now()
        }
        const p = runAgent(client, item.spec, ipc, config, agentOptions).then((result) => {
          results[item.index] = result
          running.delete(p)
          if (progress) {
            progress.runningAgents--
            progress.lastProgressAt = Date.now()
          }
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
 * @param {boolean} [config.openDashboard] - Auto-open dashboard in browser (default: false; must be explicitly `true`)
 * @param {object} [config.worktree]       - Git worktree isolation (per-node + accumulator pattern).
 *                                           { enable: true, repoDir, baseBranch, autoMerge, exec }.
 * @param {object} [config._mockClient]    - Injected mock client (testing)
 * @param {object} [config._mockIpc]       - Injected mock IPC (testing)
 */
export async function createWorkflow(config = {}) {
  emitEvent("dispatched", { workdir: config.workdir || ".workflow", model: config.model })
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
  let _needMerge = null

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

  // Dashboard refresh timer: re-render every second while workflow is running
  // so that formatDuration() for running agents always reflects current elapsed time.
  // Without this, the HTML file is written once when an agent starts, and meta
  // refresh keeps serving that same static snapshot.
  const { renderDashboard: _importedRender } = await import("./dashboard.mjs")
  const renderDashboard = config._dashboardRender || _importedRender
  let _dashboardErr = null
  const dashboardRefreshInterval = setInterval(() => {
    try {
      const status = ipc.readStatus()
      if (status && status.state === "running") {
        renderDashboard(workdir, status)
      }
    } catch (e) {
      if (!_dashboardErr) {
        _dashboardErr = e
        console.error("[workflow] dashboard refresh failed:", e.message)
      }
    }
  }, 1000)
  if (dashboardRefreshInterval.unref) dashboardRefreshInterval.unref()

  const dashboardPath = resolve(workdir, "dashboard.html")

  // Dashboard HTML is always generated; announce the file path so callers can
  // link to it regardless of whether a browser is auto-opened.
  // The browser auto-open (execFile("open", ...)) is gated by openDashboard —
  // must be opt-in, never fire in tests / headless runs.
  if (dashboardPath && !config._mockIpc && !config._mockClient) {
    console.error(`[workflow] 实时进度面板已就绪: ${dashboardPath}`)
  }
  if (config.openDashboard === true && !config._mockClient && !config._mockIpc) {
    execFile("open", [dashboardPath], (err) => {
      if (err) console.error(`[workflow] dashboard 自动打开失败: ${err.message}`)
    })
  }

  // Resolved config for runAgent
  const resolvedConfig = { ...config, maxConcurrent, model }

  // commandsDir: where main-agent writes agent_prompt_<id>.json files.
  // Configurable via config.commandsDir or post-creation assignment (wf.commandsDir = "...").
  let _commandsDir = config.commandsDir || resolve(workdir, "commands")

  return {
    get commandsDir() { return _commandsDir },
    set commandsDir(v) { _commandsDir = v },

    agent: async (type, prompt, opts = {}) => {
      const spec = { type, prompt, ...opts }
      if (ipc.advancePhase) ipc.advancePhase(config.totalPhases)
      return runAgent(client, spec, ipc, resolvedConfig)
    },

    parallel: async (specs) => {
      if (ipc.advancePhase) ipc.advancePhase(config.totalPhases)
      return runParallel(client, specs, ipc, resolvedConfig)
    },

    dag: async (nodeSpecs, opts = {}) => {
      const { EventDAGExecutor } = await import("./executor/event-driven.mjs")

      const executor = new EventDAGExecutor(resolvedConfig)
      executor.commandsDir = _commandsDir
      executor.needPrompt = needPrompt
      executor.needMerge = opts.needMerge || _needMerge || null

      const completed = await executor.execute(nodeSpecs, client, ipc)

      const resultsByNode = {}
      for (const [nodeId, { result }] of completed) {
        resultsByNode[nodeId] = result
      }

      const hasDependent = new Set()
      for (const spec of nodeSpecs) {
        for (const dep of spec.deps || []) hasDependent.add(dep)
      }

      const baseBranch = resolvedConfig.worktree?.baseBranch || "main"
      const repoDir = resolvedConfig.repoDir || resolvedConfig.worktree?.repoDir

      const terminalNodes = []
      for (const spec of nodeSpecs) {
        if (hasDependent.has(spec.id)) continue
        const entry = completed.get(spec.id)
        if (!entry?.atom?.cwd) continue

        const atomPath = entry.atom.cwd
        let branch = null
        try {
          branch = execFileSync("git", ["-C", atomPath, "branch", "--show-current"], {
            encoding: "utf8", stdio: "pipe"
          }).trim() || null
        } catch {}

        let commitAhead = null
        if (repoDir && branch) {
          try {
            const log = execFileSync("git", ["-C", repoDir, "log", `${baseBranch}..${branch}`, "--oneline"], {
              encoding: "utf8", stdio: "pipe"
            }).trim()
            commitAhead = log ? log.split("\n").length : 0
          } catch {}
        }

        const commands = branch
          ? [
              `git -C ${repoDir} checkout ${baseBranch}`,
              `git -C ${repoDir} merge --no-ff -m "workflow: merge ${spec.id} (${branch})" ${branch}`,
              `git worktree remove --force ${atomPath}`,
              `git branch -d ${branch}`,
            ]
          : []

        terminalNodes.push({ id: spec.id, branch, atomPath, commitAhead, commands })
      }

      Object.defineProperty(resultsByNode, "terminalNodes", {
        value: terminalNodes, enumerable: false,
      })
      Object.defineProperty(resultsByNode, "mergeInstructions", {
        value: () => {
          if (terminalNodes.length === 0) return "No terminal nodes to merge."
          return terminalNodes
            .map(n => [
              `### ${n.id} (${n.branch || "no branch"})`,
              `  Path  : ${n.atomPath}`,
              `  Ahead : ${n.commitAhead ?? "?"} commits`,
              ...n.commands.map(c => `  ${c}`),
            ].join("\n"))
            .join("\n\n")
        },
        enumerable: false,
      })

      return resultsByNode
    },

    status: () => {
      return ipc.readStatus()
    },

    readPrompt: (id) => readPrompt(_commandsDir, id),

    needPrompt: (id, spec = {}, opts = {}) => needPrompt(_commandsDir, id, spec, opts),

    get needMerge() { return _needMerge },
    set needMerge(fn) { _needMerge = fn },

    mergeComplete: (nodeId, result) => result,

    dashboardPath,

    snapshot,

    shutdown: async () => {
      clearInterval(cmdInterval)
      clearInterval(dashboardRefreshInterval)
      emitEvent("completed", { completedAt: Date.now() })
      ipc.updateState("completed")
      ipc.writeResult({ completedAt: Date.now() })
      closeServer()
    },
  }
}
