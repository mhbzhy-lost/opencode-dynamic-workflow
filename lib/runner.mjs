import { resolve, join } from "node:path"
import { execFile } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { create as worktreeCreate } from "./worktree.mjs"
import { createDAG, layers as dagLayers, getNode } from "./dag.mjs"
import { emitEvent } from "./events.mjs"
import { createWorktreeApi } from "./merge-gate.mjs"

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

async function runAgent(client, spec, ipc, config, options = {}) {
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
      ...(options.directory ? { query: { directory: options.directory } } : {}),
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
 * @param {boolean} [config.openDashboard] - Auto-open dashboard in browser (default: true)
 * @param {object} [config._mockClient]    - Injected mock client (testing)
 * @param {object} [config._mockIpc]       - Injected mock IPC (testing)
 */
// Global guard: only one workflow can be chdir-swapped at a time.
// createOpencodeServer SDK does not yet accept a cwd option
// (ServerOptions has no cwd/project field per node_modules/@opencode-ai/sdk/
// dist/server.d.ts), so we use process.chdir() to point it at the worktree.
//
// Known limitations (documented, not fully eliminated):
//   1. Concurrent chdir-swap is rejected via _activeChdirSwap. Concurrent
//      callers must serialize or supply config.baseUrl.
//   2. Between chdir() and the final restore in `finally`, the Node event
//      loop is free — any async activity (timers, unrelated FS) resolves
//      relative paths against the worktree. This window lasts from
//      process.chdir until the `await ensureServer` resolves. For most
//      callers this window is short (single opencode spawn + ~50-500ms).
//   3. If ensureServer throws, the `finally` block still restores CWD,
//      but async activities *during* throw propagation also see worktree.
// Mitigation path (not implemented): vendor-patch opencode SDK to accept
// a cwd option and route it through cross-spawn's `cwd` field.
let _activeChdirSwap = false

export async function createWorkflow(config = {}) {
  emitEvent("dispatched", { workdir: config.workdir || ".workflow", model: config.model })
  const workdir = config.workdir || ".workflow"
  const maxConcurrent = config.maxConcurrent || 10
  const resumeMode = config.resume || false
  const model = config.model || undefined

  // Worktree creation: must happen BEFORE ensureServer() so that
  // process.chdir() affects the spawned opencode server's project root.
  // Skipped if baseUrl is provided (user controls their own server cwd).
  //
  // chdir is a global side effect. To mitigate:
  // 1. _activeChdirSwap mutex rejects concurrent chdir attempts.
  // 2. Save/restore original cwd around ensureServer() so post-create
  //    code sees original cwd.
  // The event-loop window during `await ensureServer` is a known gap:
  // any other async code running in that interval sees worktree as cwd.
  // Single-workflow callers are unaffected.
  let worktreeState = undefined
  let worktreeApi = config._worktreeApi || null
  let accumulatorDir = null

  if (config.worktree?.enable && !config.baseUrl && !worktreeApi) {
    if (config.worktree.branch) {
      // Legacy single-worktree path: all agents share 1 worktree.
      const { repoDir, branch, baseBranch, exec } = config.worktree
      worktreeState = await worktreeCreate({ repoDir, branch, baseBranch, exec })
      if (!config._mockClient) {
        if (_activeChdirSwap) {
          throw new Error(
            "createWorkflow: concurrent chdir swap not supported; " +
            "createOpencodeServer does not expose a cwd option yet. " +
            "Either serialize workflow creation or provide config.baseUrl " +
            "to attach to an already-running server."
          )
        }
        _activeChdirSwap = true
        const prevCwd = process.cwd()
        process.chdir(worktreeState.path)
        try {
          await ensureServer(config)
        } finally {
          process.chdir(prevCwd)
          _activeChdirSwap = false
        }
      }
    } else {
      // Per-node worktree via merge-gate accumulator pattern.
      worktreeApi = createWorktreeApi({
        repoDir: config.worktree.repoDir,
        baseBranch: config.worktree.baseBranch || "main",
        exec: config.worktree.exec,
      })
    }
  }

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

  // Auto-open dashboard (default: true, skip in test/mock environments)
  if (config.openDashboard !== false && !config._mockClient && !config._mockIpc) {
    execFile("open", [dashboardPath], (err) => {
      if (err) console.error(`[workflow] dashboard 自动打开失败: ${err.message}`)
    })
    console.error(`[workflow] 实时进度面板已就绪: ${dashboardPath}`)
    console.error(`[workflow] open ${dashboardPath}`)
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

    dag: async (nodeSpecs) => {
      const dag = createDAG(nodeSpecs)
      const layerList = dagLayers(dag)
      const resultsByNode = {}

      // DAG-level progress tracker: shared across all layers so a needPrompt
      // node knows whether ANY agent in the entire DAG is still making progress.
      const progress = {
        runningAgents: 0,
        pendingPrompts: 0,
        lastProgressAt: Date.now(),
      }
      const getIdleInfo = () => ({ ...progress })

      if (worktreeApi && config.worktree?.enable) {
        accumulatorDir = await worktreeApi.ensureAccumulator(
          config.worktree.repoDir,
          config.worktree.baseBranch || "main"
        )
      }

      for (let i = 0; i < layerList.length; i++) {
        const layer = layerList[i]
        emitEvent("phase_start", { phase: i + 1, total: layerList.length, nodes: layer })
        if (ipc.advancePhase) ipc.advancePhase(layerList.length)

        const nodeWorktrees = []

        // Phase 1: resolve all prompts concurrently.
        // needsPrompt nodes block (with idle-aware timeout); ready nodes resolve instantly.
        const specs = await Promise.all(
          layer.map(async (id) => {
            const node = getNode(dag, id)
            let prompt
            if (node.needsPrompt) {
              progress.pendingPrompts++
              try {
                prompt = await needPrompt(_commandsDir, id, { type: node.type, deps: node.deps }, {
                  getIdleInfo,
                  ...(config.promptTimeout ? { pollTimeoutMs: config.promptTimeout } : {}),
                })
              } finally {
                progress.pendingPrompts--
                progress.lastProgressAt = Date.now()
              }
            } else {
              prompt = node.prompt
              for (const dep of node.deps) {
                const result = resultsByNode[dep]
                if (result) {
                  prompt = prompt.replaceAll(`{{${dep}.output}}`, result.output || "(无输出)")
                  prompt = prompt.replaceAll(`{{${dep}.error}}`, result.error || "(无错误)")
                  prompt = prompt.replaceAll(`{{${dep}.status}}`, result.status || "unknown")
                }
              }
            }
            const spec = { id, type: node.type || "general", prompt }

            if (worktreeApi && config.worktree?.enable) {
              const wt = await worktreeApi.createNode(
                config.worktree.repoDir,
                id,
                config.worktree.baseBranch || "main"
              )
              spec.directory = wt.path
              nodeWorktrees.push({ id, dir: wt.path })
            }

            return spec
          })
        )

        // Phase 2: run all agents with progress tracking for idle-aware timeout.
        const layerResults = await runParallel(client, specs, ipc, resolvedConfig, progress)
        for (const result of layerResults) {
          resultsByNode[result.id] = result
        }

        if (worktreeApi && accumulatorDir) {
          await worktreeApi.consolidate(
            nodeWorktrees.map(n => n.dir),
            accumulatorDir
          )
          for (const n of nodeWorktrees) {
            await worktreeApi.removeNode(n.dir)
          }
        }

        emitEvent("phase_end", {
          phase: i + 1,
          total: layerList.length,
          nodes: layer,
          results: layer.map(id => ({ id, status: resultsByNode[id]?.status })),
        })
      }

      return resultsByNode
    },

    status: () => {
      return ipc.readStatus()
    },

    readPrompt: (id) => readPrompt(_commandsDir, id),

    needPrompt: (id, spec = {}, opts = {}) => needPrompt(_commandsDir, id, spec, opts),

    dashboardPath,

    snapshot,

    worktree: worktreeState,

    shutdown: async () => {
      clearInterval(cmdInterval)
      clearInterval(dashboardRefreshInterval)
      emitEvent("completed", { completedAt: Date.now() })

      if (config.worktree?.autoMerge && worktreeApi?.mergeAccumulator && accumulatorDir) {
        await worktreeApi.mergeAccumulator(
          accumulatorDir,
          config.worktree.baseBranch || "main",
          { workflowId: config.id || `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }
        )
      }

      ipc.updateState("completed")
      ipc.writeResult({
        completedAt: Date.now(),
        ...(worktreeState ? { worktree: worktreeState } : {}),
        ...(accumulatorDir ? { accumulatorDir } : {}),
      })
      closeServer()
    },
  }
}
