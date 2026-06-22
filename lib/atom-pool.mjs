/**
 * Atom Pool — 管理 idle/busy atom 状态机
 *
 * 核心概念：
 *   - atom = (固定路径 P_i, 固定 worker 进程, git 状态)
 *   - worker 进程 = 启动 opencode server 的子进程
 *   - idle pool = 可复用的空闲 atoms
 *   - busy pool = 正在执行任务的 atoms
 *
 * 核心操作：
 *   - acquire(branch?) - 获取 atom（优先从 idle pool 取，池空则创建新）
 *   - release(atom) - 归还 atom 到 idle pool
 *   - reset(atom, branch) - 切换 atom 到指定分支
 *   - recycleAtom(atom) - 清理 atom 到空白状态
 *   - recycleAll() - 清理所有空闲 atoms
 *   - shutdown() - 终止所有 atoms
 */

import { fork } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const WORKER_SCRIPT = resolve(__dirname, "agent-worker.mjs")

export class AtomPool {
  constructor(repoPath, options = {}) {
    this.repoPath = repoPath
    this.idleAtoms = new Map()  // pid → atom
    this.busyAtoms = new Map()  // pid → atom
    this.options = options
  }

  /**
   * 获取可用 atom（优先从 idle pool 取，池空则创建新）
   * @param {string} [branch] - 可选，切换到的分支名
   * @returns {Promise<Object>} atom 对象 { pid, process, cwd, serverUrl }
   */
  async acquire(branch) {
    let atom
    
    if (this.idleAtoms.size > 0) {
      const [pid] = this.idleAtoms.keys()
      atom = this.idleAtoms.get(pid)
      this.idleAtoms.delete(pid)
      
      if (branch) {
        try {
          await this.reset(atom, branch)
        } catch (err) {
          this.idleAtoms.set(pid, atom)
          throw err
        }
      }
      this.busyAtoms.set(pid, atom)
    } else {
      atom = await this._createAtom()
      this.busyAtoms.set(atom.pid, atom)
      
      if (branch) {
        const currentBranch = execSync(`git branch --show-current`, {
          cwd: atom.cwd,
          encoding: "utf8"
        }).trim()
        
        if (currentBranch !== branch) {
          try {
            await this.reset(atom, branch)
          } catch (err) {
            this.busyAtoms.delete(atom.pid)
            if (atom.process && typeof atom.process.kill === "function") {
              atom.process.kill("SIGTERM")
            }
            throw err
          }
        }
      }
    }
    
    return atom
  }

  /**
   * 归还 atom 到 idle pool
   * @param {Object} atom - atom 对象
   */
  release(atom) {
    if (!atom || !this.busyAtoms.has(atom.pid)) {
      return
    }
    
    this.busyAtoms.delete(atom.pid)
    this.idleAtoms.set(atom.pid, atom)
  }

  /**
   * 创建新 atom 并切换到指定分支
   * @param {string} branch - git branch to check out
   * @returns {Promise<Object>} new atom (in busyAtoms)
   */
  async fork(branch) {
    if (!branch) {
      throw new Error("fork(branch) requires a non-empty branch name")
    }
    const atom = await this.acquire(branch)
    atom.branch = branch
    return atom
  }

  /**
   * 切换 atom 到指定分支
   * @param {Object} atom - atom 对象
   * @param {string} branch - 分支名或 commit SHA
   * @returns {Promise<void>}
   */
  async reset(atom, branch) {
    if (!atom || !atom.process || atom.process.killed) {
      throw new Error("Atom process is not running")
    }
    
    // 发送 reset 命令到 worker
    return new Promise((resolve, reject) => {
      const handler = (msg) => {
        if (msg.type === "reset-complete") {
          atom.process.removeListener("message", handler)
          resolve()
        } else if (msg.type === "error" && msg.context === "reset") {
          atom.process.removeListener("message", handler)
          reject(new Error(msg.message))
        }
      }
      
      atom.process.on("message", handler)
      atom.process.send({ type: "reset", branch })
      
      // 超时保护
      setTimeout(() => {
        atom.process.removeListener("message", handler)
        reject(new Error("Reset timeout"))
      }, 30000)
    })
  }

  /**
   * 清理 atom 到空白状态
   * @param {Object} atom - atom 对象
   * @returns {Promise<void>}
   */
  async recycleAtom(atom) {
    if (!atom || !atom.process || atom.process.killed) {
      return
    }
    
    return new Promise((resolve, reject) => {
      const handler = (msg) => {
        if (msg.type === "recycle-complete") {
          atom.process.removeListener("message", handler)
          resolve()
        } else if (msg.type === "error" && msg.context === "recycle") {
          atom.process.removeListener("message", handler)
          reject(new Error(msg.message))
        }
      }
      
      atom.process.on("message", handler)
      atom.process.send({ type: "recycle" })
      
      // 超时保护
      setTimeout(() => {
        atom.process.removeListener("message", handler)
        reject(new Error("Recycle timeout"))
      }, 10000)
    })
  }

  /**
   * 将 source atom 的 worktree 合并到 target atom
   * @param {Object} sourceAtom - 源 atom
   * @param {Object} targetAtom - 目标 atom
   * @returns {Promise<void>}
   */
  async merge(sourceAtom, targetAtom) {
    if (!sourceAtom || !targetAtom) {
      throw new Error("Both source and target atoms are required")
    }

    // 获取 source atom 的当前分支
    const sourceBranch = execSync(
      `git branch --show-current`,
      { cwd: sourceAtom.cwd, encoding: "utf8" }
    ).trim()

    if (!sourceBranch) {
      throw new Error("Source atom has no current branch")
    }

    // 在 target atom 执行 merge
    try {
      execSync(
        `git merge ${sourceBranch} --no-ff -m "merge ${sourceBranch}"`,
        { cwd: targetAtom.cwd, stdio: "pipe" }
      )
    } catch (err) {
      const stdout = err.stdout?.toString() || ""
      const stderr = err.stderr?.toString() || ""
      
      if (stderr.includes("CONFLICT") || stdout.includes("CONFLICT")) {
        // 遇到冲突，回退 merge 并抛出详细错误
        execSync(`git merge --abort`, { cwd: targetAtom.cwd, stdio: "ignore" })
        throw new Error(
          `Merge conflict when merging ${sourceBranch} into target:\n${stdout}\n${stderr}`
        )
      } else {
        throw new Error(`Merge failed: ${stderr}`)
      }
    }
  }

  /**
   * 清理所有空闲 atoms
   * @returns {Promise<void>}
   */
  async recycleAll() {
    const promises = Array.from(this.idleAtoms.values()).map(atom => 
      this.recycleAtom(atom)
    )
    await Promise.all(promises)
    
    // 清理后终止这些 atoms
    for (const [pid, atom] of this.idleAtoms) {
      atom.process.kill("SIGTERM")
      this.idleAtoms.delete(pid)
    }
  }

  /**
   * 终止所有 atoms（idle + busy）
   */
  shutdown() {
    for (const atom of this.idleAtoms.values()) {
      if (atom.process && !atom.process.killed) {
        atom.process.kill("SIGTERM")
      }
    }
    this.idleAtoms.clear()
    
    for (const atom of this.busyAtoms.values()) {
      if (atom.process && !atom.process.killed) {
        atom.process.kill("SIGTERM")
      }
    }
    this.busyAtoms.clear()
  }

  /**
   * 获取状态统计
   */
  get status() {
    return {
      idleCount: this.idleAtoms.size,
      busyCount: this.busyAtoms.size,
      totalCount: this.idleAtoms.size + this.busyAtoms.size,
    }
  }

  /**
   * 获取空闲 atoms 数量
   */
  get idleCount() {
    return this.idleAtoms.size
  }

  /**
   * 获取忙碌 atoms 数量
   */
  get busyCount() {
    return this.busyAtoms.size
  }

  /**
   * 创建新 atom（内部方法）
   * @returns {Promise<Object>} atom 对象
   */
  async _createAtom() {
    // 使用 .workflow/worktrees/ 结构创建 worktree 路径
    const worktreeDir = resolve(this.repoPath, ".workflow", "worktrees")
    execSync(`mkdir -p "${worktreeDir}"`)
    
    const atomId = `atom-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const cwd = resolve(worktreeDir, atomId)
    const branchName = `wf/${atomId}`
    
    // 使用 git worktree add 创建真正的 worktree（创建新分支避免冲突）
    execSync(`git worktree add "${cwd}" -b "${branchName}"`, { 
      cwd: this.repoPath, 
      stdio: "ignore" 
    })
    
    return new Promise((resolveP, rejectP) => {
      const proc = fork(WORKER_SCRIPT, {
        cwd,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env }
      })
      
      const stdoutBuf = []
      const stderrBuf = []
      
      proc.stdout.on("data", d => stdoutBuf.push(d.toString()))
      proc.stderr.on("data", d => stderrBuf.push(d.toString()))
      
      // 等待 ready 消息
      const handler = (msg) => {
        if (msg.type === "ready") {
          proc.removeListener("message", handler)
          resolveP({
            pid: proc.pid,
            process: proc,
            cwd,
            serverUrl: msg.serverUrl
          })
        } else if (msg.type === "error") {
          proc.removeListener("message", handler)
          rejectP(new Error(msg.message))
        }
      }
      
      proc.on("message", handler)
      
      proc.on("exit", (code) => {
        if (code !== null && code !== 0) {
          rejectP(new Error(`Worker exited with code ${code}: ${stderrBuf.join("")}`))
        }
      })
      
      // 发送 start 命令
      proc.send({ type: "start" })
      
      // 超时保护
      setTimeout(() => {
        proc.removeListener("message", handler)
        proc.kill("SIGTERM")
        rejectP(new Error(`Atom creation timeout: ${stderrBuf.join("")}`))
      }, 30000)
    })
  }
}
