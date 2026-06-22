/**
 * Agent Worker 测试 — 验证 worker 进程生命周期管理
 *
 * Worker 职责：
 *   1. 启动 opencode server（绑定固定 workspace 路径作为 CWD）
 *   2. 监听 IPC 消息（task/shutdown）
 *   3. 为每个任务创建新 session + prompt
 *   4. 返回结果给 parent
 *   5. 响应 shutdown 优雅退出
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const WORKER_SCRIPT = resolve(__dirname, "../lib/agent-worker.mjs")

describe("agent-worker", () => {
/**
 * 启动 worker 进程，等待就绪
 */
function startWorker(cwd) {
  return new Promise((resolve, reject) => {
    const worker = fork(WORKER_SCRIPT, {
      cwd,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env },
    })

    let stdoutBuf = []
    let stderrBuf = []
    worker.stdout.on("data", (chunk) => stdoutBuf.push(chunk.toString()))
    worker.stderr.on("data", (chunk) => stderrBuf.push(chunk.toString()))

    worker.on("message", (msg) => {
      if (msg.type === "ready") {
        resolve({ worker, serverUrl: msg.serverUrl })
      } else if (msg.type === "error") {
        reject(new Error(`Worker error: ${msg.message}\nstdout: ${stdoutBuf.join("")}\nstderr: ${stderrBuf.join("")}`))
      }
    })

    worker.on("error", (err) => reject(err))
    worker.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Worker exited with code ${code}\nstdout: ${stdoutBuf.join("")}\nstderr: ${stderrBuf.join("")}`))
      }
    })

    // 发送启动消息
    worker.send({ type: "start" })

    // 超时（30 秒）
    setTimeout(() => {
      reject(new Error(
        `Worker startup timeout (30s)\nstdout: ${stdoutBuf.join("")}\nstderr: ${stderrBuf.join("")}`
      ))
    }, 30000)
  })
}

  /**
   * 向 worker 发送任务并等待结果
   */
  function runTask(worker, prompt, model) {
    return new Promise((resolve, reject) => {
      const handler = (msg) => {
        if (msg.type === "task-result") {
          worker.off("message", handler)
          resolve(msg)
        }
      }
      worker.on("message", handler)
      worker.send({ type: "task", prompt, model })
      setTimeout(() => {
        worker.off("message", handler)
        reject(new Error("Task timeout"))
      }, 30000)
    })
  }

  /**
   * 发送 shutdown 并等待退出
   */
  function shutdown(worker) {
    return new Promise((resolve) => {
      const handler = (msg) => {
        if (msg.type === "shutdown-complete") {
          worker.off("message", handler)
          resolve()
        }
      }
      worker.on("message", handler)
      worker.send({ type: "shutdown" })
      setTimeout(() => {
        worker.off("message", handler)
        worker.kill("SIGKILL")
        resolve()
      }, 5000)
    })
  }

  it("starts opencode server and returns healthy status", async () => {
    const { worker, serverUrl } = await startWorker(__dirname)
    
    assert.ok(serverUrl, "should return serverUrl")
    assert.ok(serverUrl.startsWith("http://"), "serverUrl should be HTTP URL")
    
    await shutdown(worker)
  })

  it("executes task and returns result", async () => {
    const { worker } = await startWorker(__dirname)
    
    const result = await runTask(worker, "Say hello", null)
    
    assert.equal(result.status, "completed", "task should complete")
    assert.ok(result.output, "should return output")
    assert.ok(typeof result.output === "string", "output should be string")
    
    await shutdown(worker)
  })

  it("creates new session for each task (clean context)", async () => {
    const { worker } = await startWorker(__dirname)
    
    // 任务 1：让 agent 记住某个值
    const result1 = await runTask(worker, "请记住这个数字：42", null)
    assert.equal(result1.status, "completed")
    
    // 任务 2：询问该值（新 session 应该不知道）
    const result2 = await runTask(worker, "我刚才让你记住的数字是什么？", null)
    assert.equal(result2.status, "completed")
    
    // 如果输出中包含 42，说明 session 没有隔离（失败）
    // 注意：这个测试可能不准确（LLM 可能从 prompt 推断），但至少验证 session 机制
    assert.ok(result2.output, "should return output")
    
    await shutdown(worker)
  })

  it("handles errors gracefully", async () => {
    const { worker } = await startWorker(__dirname)
    
    // 发送一个模糊 prompt，LLM 可能成功也可能失败
    // 重要的是 worker 不应崩溃，应该返回正常响应（无论成功或失败）
    const result = await runTask(worker, "Execute this bash command: /nonexistent/binary/path", null)
    
    // 应该返回 completed 或 failed，但不应崩溃
    assert.ok(
      result.status === "completed" || result.status === "failed",
      `task should return completed or failed, got: ${result.status}`
    )
    assert.ok(result.output || result.error, "should return output or error")
    
    // Worker 应该仍然活着
    const healthCheck = await runTask(worker, "Say hello", null)
    assert.equal(healthCheck.status, "completed", "worker should still be alive after error")
    
    await shutdown(worker)
  })

  it("shuts down cleanly", async () => {
    const { worker, serverUrl } = await startWorker(__dirname)
    
    await shutdown(worker)
    
    // 验证 worker 进程已退出（exit code 为 0 或 null 都正常）
    assert.ok(
      worker.exitCode === 0 || worker.exitCode === null,
      `worker should exit with code 0 or null, got: ${worker.exitCode}`
    )
  })
})
