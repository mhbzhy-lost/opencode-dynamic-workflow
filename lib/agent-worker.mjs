/**
 * Agent Worker 进程 — 独立子进程，管理 opencode server 生命周期
 *
 * 职责：
 *   1. 启动 opencode server（绑定固定 workspace 路径）
 *   2. 监听 IPC 消息（task/shutdown）
 *   3. 为每个任务创建新 session + prompt
 *   4. 返回结果给 parent
 *   5. 响应 shutdown 优雅退出
 *
 * IPC 消息协议：
 *   - { type: 'start' } → 启动 server，返回 { type: 'ready', serverUrl }
 *   - { type: 'task', prompt, model } → 执行任务，返回 { type: 'task-result', status, output/error }
 *   - { type: 'shutdown' } → 优雅退出，返回 { type: 'shutdown-complete' }
 */

import { spawn } from "node:child_process"
import { createOpencodeClient } from "@opencode-ai/sdk"

let serverProcess = null
let serverUrl = null
let client = null

/**
 * 启动 opencode server
 */
async function startServer() {
  return new Promise((resolve, reject) => {
    // 使用 --port 0 让系统分配端口
    serverProcess = spawn("opencode", ["serve", "--port", "0", "--print-logs", "--log-level", "INFO"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    })

    let stderrBuf = []
    let stdoutBuf = []
    serverProcess.stderr.on("data", (chunk) => stderrBuf.push(chunk.toString()))
    serverProcess.stdout.on("data", (chunk) => stdoutBuf.push(chunk.toString()))

    // 监听 server 启动完成（从 stdout/stderr 解析 port）
    const checkReady = () => {
      const all = stdoutBuf.join("") + stderrBuf.join("")
      const match = all.match(/listening on (?:http:\/\/)?(\S+?):(\d+)/)
        || all.match(/server started.*?:(\d+)/)
        || all.match(/(?:address|port)\D+(\d{4,5})/)
      if (match) {
        const port = parseInt(match[match.length - 1], 10)
        serverUrl = `http://127.0.0.1:${port}`
        resolve(serverUrl)
      }
    }

    serverProcess.stdout.on("data", checkReady)
    serverProcess.stderr.on("data", checkReady)

    serverProcess.on("error", (err) => {
      reject(new Error(`Failed to start opencode server: ${err.message}`))
    })

    serverProcess.on("exit", (code) => {
      if (!serverUrl) {
        reject(new Error(
          `opencode server exited with code ${code} before becoming ready.\n` +
          `stdout: ${stdoutBuf.join("")}\n` +
          `stderr: ${stderrBuf.join("")}`
        ))
      }
    })

    // 超时
    setTimeout(() => {
      if (!serverUrl) {
        serverProcess.kill("SIGTERM")
        reject(new Error(
          `opencode server startup timeout (30s)\n` +
          `stdout: ${stdoutBuf.join("")}\n` +
          `stderr: ${stderrBuf.join("")}`
        ))
      }
    }, 30000)
  })
}

/**
 * 创建 opencode client
 */
function createClient(baseUrl) {
  return createOpencodeClient({ baseUrl })
}

/**
 * 执行任务：创建新 session + prompt
 */
async function executeTask(prompt, model) {
  if (!client) {
    throw new Error("Client not initialized")
  }

  try {
    // 创建新 session（隔离上下文）
    const session = await client.session.create({
      body: { title: `worker-task-${Date.now()}` },
    })
    const sessionId = session.data?.id

    if (!sessionId) {
      throw new Error("Failed to create session")
    }

    // 构建 prompt body
    const body = {
      parts: [{ type: "text", text: prompt }],
    }

    if (model) {
      body.model = model
    }

    // 执行 prompt
    const result = await client.session.prompt({
      path: { id: sessionId },
      body,
    })

    // 解析结果
    const parts = result.data?.parts || []
    const output = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n")

    return { status: "completed", output }
  } catch (err) {
    return { status: "failed", error: err.message }
  }
}

/**
 * 切换分支：将 worktree 切换到指定分支或 commit
 */
async function resetAtom(branch) {
  const { execSync } = await import("node:child_process")
  
  try {
    // 获取当前目录（opencode server 的工作目录）
    const cwd = process.cwd()
    
    // 检查是否为 git 仓库
    try {
      execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "ignore" })
    } catch {
      // 不是 git 仓库，跳过 reset
      return
    }
    
    // stash 当前改动
    execSync("git stash", { cwd, stdio: "ignore" })
    
    // 切换到目标分支或 commit
    execSync(`git checkout ${branch}`, { cwd, stdio: "ignore" })
    
    // 清理 untracked 文件
    execSync("git clean -fd", { cwd, stdio: "ignore" })
  } catch (err) {
    throw new Error(`Failed to reset atom to ${branch}: ${err.message}`)
  }
}

/**
 * 回收 atom：清理工作区到空白状态
 */
async function recycleAtom() {
  const { execSync } = await import("node:child_process")
  
  try {
    const cwd = process.cwd()
    
    // 检查是否为 git 仓库
    try {
      execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "ignore" })
    } catch {
      return
    }
    
    // 清理所有未提交改动
    execSync("git reset --hard HEAD", { cwd, stdio: "ignore" })
    execSync("git clean -fd", { cwd, stdio: "ignore" })
    
    // stash clean
    execSync("git stash clear", { cwd, stdio: "ignore" })
  } catch (err) {
    throw new Error(`Failed to recycle atom: ${err.message}`)
  }
}

/**
 * 优雅关闭 server
 */
function shutdownServer() {
  if (serverProcess) {
    serverProcess.kill("SIGTERM")
    serverProcess = null
  }
  serverUrl = null
  client = null
}

/**
 * 主循环：监听 IPC 消息
 */
function main() {
  process.on("message", async (msg) => {
    try {
      if (msg.type === "start") {
        // 启动 server
        serverUrl = await startServer()
        client = createClient(serverUrl)
        process.send({ type: "ready", serverUrl })
      } else if (msg.type === "task") {
        // 执行任务
        const result = await executeTask(msg.prompt, msg.model)
        process.send({ type: "task-result", ...result })
      } else if (msg.type === "reset") {
        // 切换到指定分支
        await resetAtom(msg.branch)
        process.send({ type: "reset-complete" })
      } else if (msg.type === "recycle") {
        // 回收 atom（清理到空白状态）
        await recycleAtom()
        process.send({ type: "recycle-complete" })
      } else if (msg.type === "shutdown") {
        // 优雅退出
        shutdownServer()
        process.send({ type: "shutdown-complete" })
        process.exit(0)
      }
    } catch (err) {
      process.send({ 
        type: "error", 
        message: err.message,
        context: msg.type  // 传递错误上下文
      })
    }
  })

  // 处理意外退出
  process.on("uncaughtException", (err) => {
    console.error("Worker uncaughtException:", err)
    shutdownServer()
    process.exit(1)
  })

  process.on("SIGTERM", () => {
    shutdownServer()
    process.exit(0)
  })

  process.on("SIGINT", () => {
    shutdownServer()
    process.exit(0)
  })
}

// 启动
main()
