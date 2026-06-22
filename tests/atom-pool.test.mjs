/**
 * Atom Pool 测试 — 验证 idle/busy atom 状态机
 *
 * 核心功能：
 *   1. acquire() - 从 idle pool 获取 atom，切换到目标状态
 *   2. release() - 将 atom 归还 idle pool
 *   3. reset() - 切换 atom 到指定分支/commit
 *   4. recycleAtom() - 清理 atom（reset 到 empty）
 *   5. recycleAll() - 清理所有 atoms
 */
import { describe, it, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"
import { AtomPool } from "../lib/atom-pool.mjs"

const __dirname = fileURLToPath(new URL(".", import.meta.url))

describe("atom-pool", () => {
  let tempRepo
  let pool

  beforeEach(() => {
    // 创建临时 git 仓库
    tempRepo = mkdtempSync(resolve(tmpdir(), "atom-pool-test-"))
    execSync("git init", { cwd: tempRepo, stdio: "ignore" })
    execSync("git config user.email 'test@test.com'", { cwd: tempRepo, stdio: "ignore" })
    execSync("git config user.name 'Test'", { cwd: tempRepo, stdio: "ignore" })
    execSync("git commit --allow-empty -m 'init'", { cwd: tempRepo, stdio: "ignore" })
    
    pool = new AtomPool(tempRepo)
  })

  after(() => {
    if (pool) pool.shutdown()
    if (tempRepo) rmSync(tempRepo, { recursive: true, force: true })
  })

  it("starts with empty idle and busy pools", () => {
    assert.equal(pool.idleCount, 0)
    assert.equal(pool.busyCount, 0)
  })

  it("acquire() creates new atom when idle pool is empty", async () => {
    const atom = await pool.acquire()
    assert.ok(atom)
    assert.ok(atom.pid)
    assert.equal(pool.busyCount, 1)
    assert.equal(pool.idleCount, 0)
  })

  it("release() moves atom from busy to idle", async () => {
    const atom = await pool.acquire()
    pool.release(atom)
    assert.equal(pool.busyCount, 0)
    assert.equal(pool.idleCount, 1)
  })

  it("acquire() reuses atom from idle pool", async () => {
    const atom1 = await pool.acquire()
    pool.release(atom1)
    
    const atom2 = await pool.acquire()
    assert.equal(atom2, atom1, "should reuse same atom")
    assert.equal(pool.idleCount, 0)
  })

  it("acquire() with branch name switches to that branch", async () => {
    // 创建分支
    execSync("git checkout -b feature-x", { cwd: tempRepo, stdio: "ignore" })
    execSync("touch x.txt", { cwd: tempRepo, stdio: "ignore" })
    execSync("git add x.txt && git commit -m 'x'", { cwd: tempRepo, stdio: "ignore" })
    execSync("git checkout main", { cwd: tempRepo, stdio: "ignore" })
    
    const atom = await pool.acquire("feature-x")
    
    // 验证 atom 已切换到 feature-x
    const branch = execSync("git branch --show-current", { 
      cwd: atom.cwd, 
      encoding: "utf8" 
    }).trim()
    assert.equal(branch, "feature-x")
  })

  it("reset() switches atom to different branch", async () => {
    // 创建两个分支
    execSync("git checkout -b feature-a", { cwd: tempRepo, stdio: "ignore" })
    execSync("touch a.txt && git add a.txt && git commit -m 'a'", { cwd: tempRepo, stdio: "ignore" })
    execSync("git checkout main", { cwd: tempRepo, stdio: "ignore" })
    
    execSync("git checkout -b feature-b", { cwd: tempRepo, stdio: "ignore" })
    execSync("touch b.txt && git add b.txt && git commit -m 'b'", { cwd: tempRepo, stdio: "ignore" })
    execSync("git checkout main", { cwd: tempRepo, stdio: "ignore" })
    
    const atom = await pool.acquire("feature-a")
    await pool.reset(atom, "feature-b")
    
    const branch = execSync("git branch --show-current", { 
      cwd: atom.cwd, 
      encoding: "utf8" 
    }).trim()
    assert.equal(branch, "feature-b")
    
    // 验证 b.txt 存在
    const files = execSync("ls", { cwd: atom.cwd, encoding: "utf8" })
    assert.ok(files.includes("b.txt"))
  })

  it("recycleAtom() resets atom to empty state", async () => {
    const atom = await pool.acquire()
    
    // 在 atom 中创建文件
    execSync("touch dirty.txt", { cwd: atom.cwd, stdio: "ignore" })
    
    await pool.recycleAtom(atom)
    
    // 验证文件已清理
    const files = execSync("ls -A", { cwd: atom.cwd, encoding: "utf8" })
    assert.ok(!files.includes("dirty.txt"))
  })

  it("recycleAll() clears all idle atoms", async () => {
    const atom1 = await pool.acquire()
    const atom2 = await pool.acquire()
    pool.release(atom1)
    pool.release(atom2)
    
    assert.equal(pool.idleCount, 2)
    
    await pool.recycleAll()
    
    assert.equal(pool.idleCount, 0)
  })

  it("handles multiple concurrent atoms", async () => {
    const atoms = await Promise.all([
      pool.acquire(),
      pool.acquire(),
      pool.acquire(),
    ])
    
    assert.equal(pool.busyCount, 3)
    
    atoms.forEach(a => pool.release(a))
    
    assert.equal(pool.idleCount, 3)
  })

  describe("fork(branch)", () => {
    it("creates new atom checked out to given branch", async () => {
      const pool2 = new AtomPool(tempRepo, { baseBranch: "main" })
      pool2._createAtom = async () => ({
        pid: 200,
        cwd: tempRepo,
        process: { killed: false, send: () => {}, on: () => {}, removeListener: () => {}, kill: () => {} },
      })
      pool2.reset = async () => {}

      const forked = await pool2.fork("wf-A")

      assert.equal(forked.pid, 200)
      assert.ok(pool2.busyAtoms.has(200))
      assert.equal(forked.branch, "wf-A")

      pool2.shutdown()
    })

    it("throws when branch is empty", async () => {
      const pool2 = new AtomPool(tempRepo, { baseBranch: "main" })
      await assert.rejects(() => pool2.fork(""), /requires a non-empty branch/)
      pool2.shutdown()
    })

    it("throws when branch is undefined", async () => {
      const pool2 = new AtomPool(tempRepo, { baseBranch: "main" })
      await assert.rejects(() => pool2.fork(), /requires a non-empty branch/)
      pool2.shutdown()
    })
  })

  it("returns atom to idle pool when reset fails during acquire", async () => {
    // Mock _createAtom to avoid real child_process creation.
    pool._createAtom = async () => ({
      pid: 9001,
      cwd: tempRepo,
      process: { killed: false, send: () => {}, on: () => {}, removeListener: () => {}, kill: () => {} },
    })

    // Arrange: acquire + release → idle pool has 1 atom; reset is the real IPC path we'll replace
    const atom = await pool.acquire()
    pool.release(atom)
    assert.equal(pool.idleCount, 1)
    assert.equal(pool.busyCount, 0)

    // Replace reset with one that throws (simulates git checkout failure)
    const origReset = pool.reset
    pool.reset = async () => { throw new Error("simulated reset failure") }

    // Act: acquire with a branch triggers reset; reset fails → atom must NOT leak into busy pool
    let err = null
    try {
      await pool.acquire("nonexistent-branch")
    } catch (e) {
      err = e
    } finally {
      pool.reset = origReset
    }

    // Assert
    assert.ok(err, "acquire must propagate reset failure to the caller")
    assert.match(err.message, /reset failure/)
    assert.equal(pool.busyCount, 0, "atom must not leak into busy pool after reset failure")
    assert.equal(pool.idleCount, 1, "atom must be returned to idle pool after reset failure")
  })

  it("shutdown() terminates all atoms", async () => {
    const atom1 = await pool.acquire()
    const atom2 = await pool.acquire()
    pool.release(atom1)
    
    // atom1 in idle, atom2 in busy
    pool.shutdown()
    
    assert.equal(pool.idleCount, 0)
    assert.equal(pool.busyCount, 0)
  })
})
