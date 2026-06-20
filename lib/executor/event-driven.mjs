/**
 * Event-driven DAG executor
 * 
 * 使用事件驱动模式执行 DAG，替代旧的 layers 循环：
 * - 任务完成时触发晋升决策
 * - 通过 PromotionCoordinator 管理 ref counting
 * - 通过 AtomPool 管理 atoms
 */
import { createDAG, dependents, isReady } from "../dag.mjs"
import { countRefs } from "../utils.mjs"
import { PromotionCoordinator, promote } from "../promote.mjs"
import { AtomPool } from "../atom-pool.mjs"
import { emitEvent } from "../events.mjs"

/**
 * EventDAGExecutor - 事件驱动的 DAG 执行器
 */
export class EventDAGExecutor {
  constructor(config) {
    this.config = config
    this.completed = new Map()  // nodeId -> { result, atom }
    this.failed = new Map()     // nodeId -> error
    this.running = new Set()    // 正在执行的 task ids
    this.ready = new Set()      // 已经 ready 但还没执行的 task ids
    this.taskPromises = new Map()  // nodeId -> Promise
    
    this.atomPool = null
    this.coordinator = null  // ref counting coordinator
    this.client = null  // opencode SDK client
    this.ipc = null  // IPC manager
    this.needPrompt = null  // callback for handling needsPrompt
  }
  
  async execute(dagSpecs, client, ipc, needPromptCallback) {
    this.client = client
    this.ipc = ipc
    this.needPrompt = needPromptCallback || this.needPrompt
    this.phaseCount = 0  // track phases for event emission
    
    const dag = createDAG(dagSpecs)
    const refs = countRefs(dag)
    
    // 初始化 Atom Pool (仅在配置 worktree 时)
    if (this.config.repoDir && this.config.worktree?.enable) {
      this.atomPool = new AtomPool(this.config.repoDir, this.config.worktree)
    }
    
    // 初始化 PromotionCoordinator
    this.coordinator = new PromotionCoordinator(refs)
    
    // 找到初始 ready 的 tasks（没有依赖的）
    for (const node of dag.nodes.values()) {
      if (isReady(dag, node.id, [])) {
        this.ready.add(node.id)
      }
    }
    
    // 事件驱动执行循环
    while (this.ready.size > 0 || this.running.size > 0) {
      // 如果有 ready tasks，执行它们（这是一个 phase）
      if (this.ready.size > 0) {
        const phaseNodes = Array.from(this.ready)
        this.phaseCount++
        
        // 发射 phase_start 事件
        emitEvent("phase_start", { 
          phase: this.phaseCount, 
          nodes: phaseNodes 
        })
        
        await this._executeReadyTasks(dag)
        
        // 等待该批次完成
        if (this.running.size > 0) {
          await this._waitForAnyCompletion(dag)
        }
        
        // 发射 phase_end 事件
        emitEvent("phase_end", { 
          phase: this.phaseCount, 
          nodes: phaseNodes,
          results: phaseNodes.map(id => ({ 
            id, 
            status: this.completed.get(id)?.result?.status 
          }))
        })
      }
      
      // 等待任意一个 running task 完成
      if (this.running.size > 0) {
        await this._waitForAnyCompletion(dag)
      }
    }
    
    // 返回结果
    return this.completed
  }
  
  async _executeReadyTasks(dag) {
    const tasksToRun = new Set(this.ready)
    this.ready.clear()
    
    // 为每个 ready 任务启动执行（不等待完成）
    for (const nodeId of tasksToRun) {
      const node = dag.nodes.get(nodeId)
      
      // 晋升决策
      const deps = Array.from((node.deps instanceof Map ? Array.from(node.deps) : node.deps) || [])
      
      // 根节点（无依赖）直接 acquire
      let decision;
      if (deps.length === 0) {
        decision = { action: 'acquire' };
      } else {
        decision = this.coordinator.promote(nodeId, deps, this.completed);
      }
      
      // 获取 atom
      const atom = await this._getAtomForDecision(decision)
      
      // 处理需要 prompt 的任务
      let finalPrompt = node.prompt
      if (node.needsPrompt) {
        if (!this.needPrompt) {
          throw new Error(`Task ${nodeId} requires needsPrompt but needPrompt callback not provided`)
        }
        // Pass commandsDir as first parameter (from config), then id, spec, and opts
        finalPrompt = await this.needPrompt(
          this.commandsDir,
          nodeId,
          {
            type: node.type || 'general',
            deps: deps,
          },
          {}
        )
      }
      
      // 替换依赖输出占位符
      if (Array.isArray(deps)) {
        for (const dep of deps) {
          const depResult = this.completed.get(dep)
          if (depResult?.result?.output) {
            finalPrompt = finalPrompt.replaceAll(`{{${dep}.output}}`, depResult.result.output)
          }
        }
      }
      
      // 启动任务执行
      this.running.add(nodeId)
      const taskPromise = this._runTask(nodeId, { ...node, prompt: finalPrompt }, atom)
        .then(result => {
          this.completed.set(nodeId, { result, atom })
          this.running.delete(nodeId)
          this._checkDependents(dag, nodeId)
        })
        .catch(err => {
          this.failed.set(nodeId, err)
          this.running.delete(nodeId)
          throw err
        })
      
      this.taskPromises.set(nodeId, taskPromise)
    }
    
    // 不等待，让任务并行执行
    // 由 _waitForAnyCompletion 来等待第一个完成的任务
  }
  
  async _waitForAnyCompletion(dag) {
    // 等待任意一个 running task 完成
    const runningPromises = []
    for (const nodeId of this.running) {
      const promise = this.taskPromises.get(nodeId)
      if (promise) {
        runningPromises.push(promise.then(() => nodeId).catch(() => nodeId))
      }
    }
    
    if (runningPromises.length > 0) {
      await Promise.race(runningPromises)
    }
  }
  
  async _getAtomForDecision(decision) {
    // 如果没有配置 atomPool，直接返回 null（不使用 worktree 隔离）
    if (!this.atomPool) {
      return null
    }
    
    switch (decision.action) {
      case 'inherit':
        // 从 completed map 中获取 atom
        return this.completed.get(decision.primaryAtom).atom
      
      case 'fork': {
        const sourceNodeId = decision.primaryAtom
        const branch = `wf-${sourceNodeId}`
        return await this.atomPool.fork(branch)
      }
      
      case 'acquire':
        // 创建新 atom 并合并依赖
        const newAtom = await this.atomPool.acquire()
        
        // 执行 merge 操作 (T3.4)
        // 只在 newAtom 非空时才执行 merge
        if (decision.toMerge && decision.toMerge.length > 0 && newAtom) {
          for (const depId of decision.toMerge) {
            const depAtom = this.completed.get(depId).atom
            if (depAtom) {  // 只在有 atom 时才 merge
              await this.atomPool.merge(depAtom, newAtom)
            }
          }
        }
        
        // 执行 recycle 操作 (T3.4)
        if (decision.toRecycle && decision.toRecycle.length > 0) {
          for (const depId of decision.toRecycle) {
            const depAtom = this.completed.get(depId).atom
            if (depAtom) {  // 只在有 atom 时才 recycle
              await this.atomPool.recycleAtom(depAtom)
              await this.atomPool.release(depAtom)
              // 从 completed 中移除，因为已经 recycle 了
              this.completed.delete(depId)
            }
          }
        }
        
        return newAtom
      
      default:
        throw new Error(`Unknown decision action: ${decision.action}`)
    }
  }
  

  _checkDependents(dag, completedNodeId) {
    // 检查 dependents 是否 ready
    const dependentsList = dependents(dag, completedNodeId)
    for (const depId of dependentsList) {
      const ready = isReady(dag, depId, [...this.completed.keys()])
      if (ready) {
        this.ready.add(depId)
      }
    }
  }
  
  async _runTask(nodeId, nodeSpec, atom) {
    // 使用 opencode SDK 执行任务
    const agentId = nodeId
    const startedAt = Date.now()
    
    this.ipc.updateAgentStatus(agentId, {
      type: nodeSpec.type || 'general',
      status: 'running',
      prompt: nodeSpec.prompt,
      startedAt,
    })
    
    try {
      // 创建 session
      const session = await this.client.session.create({
        body: { title: `${nodeSpec.type || 'general'}: ${agentId}` },
      })
      
      const sessionId = session.data?.id ?? session.data.id
      this.ipc.updateAgentStatus(agentId, { sessionId })
      
      // 执行 session.prompt
      const promptBody = {
        parts: [{ type: 'text', text: nodeSpec.prompt }],
      }
      
      // 只在有 atom 时指定 directory
      const promptParams = atom?.cwd 
        ? { path: { id: sessionId }, body: promptBody, query: { directory: atom.cwd } }
        : { path: { id: sessionId }, body: promptBody }
      
      const result = await this.client.session.prompt(promptParams)
      
      // SDK response: { data: { info: AssistantMessage, parts: Part[] } }
      // Mock response: { data: { parts: [{ type: "text", text }] } }
      const parts = result.data?.parts || []
      const output = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")

      const durationMs = Date.now() - startedAt
      
      this.ipc.updateAgentStatus(agentId, {
        status: 'completed',
        output,
        finishedAt: Date.now(),
        durationMs,
      })
      
      return {
        id: agentId,
        status: 'completed',
        output,
        durationMs,
      }
    } catch (err) {
      const durationMs = Date.now() - startedAt
      
      this.ipc.updateAgentStatus(agentId, {
        status: 'failed',
        finishedAt: Date.now(),
        durationMs,
        error: err.message,
      })
      
      throw err
    }
  }
}
