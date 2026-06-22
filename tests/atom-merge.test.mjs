/**
 * T3.3: Merge Operations Tests
 * 
 * Tests atom-to-atom merge functionality:
 * - Merging one atom's worktree into another
 * - Preserving commits from source atom
 * - Handling merge conflicts (if any)
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { AtomPool } from "../lib/atom-pool.mjs"

describe("T3.3: Merge Operations", () => {
  let testRepo
  let pool

  before(async () => {
    // 创建新的 git 仓库
    testRepo = mkdtempSync(join(tmpdir(), "atom-merge-"))
    
    execSync("git init", { cwd: testRepo, stdio: "ignore" })
    execSync("git config user.email test@test.com", { cwd: testRepo, stdio: "ignore" })
    execSync("git config user.name Test", { cwd: testRepo, stdio: "ignore" })
    
    // 创建初始提交
    execSync("touch initial.txt", { cwd: testRepo, stdio: "ignore" })
    execSync("git add .", { cwd: testRepo, stdio: "ignore" })
    execSync("git commit -m 'init'", { cwd: testRepo, stdio: "ignore" })
    
    pool = new AtomPool(testRepo)
  })

  after(() => {
    pool.shutdown()
    execSync(`rm -rf ${testRepo}`, { stdio: "ignore" })
  })

  it("merge source atom into target atom", async () => {
    const sourceAtom = await pool.acquire()
    const targetAtom = await pool.acquire()
    
    // Source: 创建并提交文件 A
    writeFileSync(join(sourceAtom.cwd, "file-a.txt"), "content from source")
    execSync("git add .", { cwd: sourceAtom.cwd, stdio: "ignore" })
    execSync("git commit -m 'add file-a from source'", { cwd: sourceAtom.cwd, stdio: "ignore" })
    
    // Target: 创建并提交文件 B
    writeFileSync(join(targetAtom.cwd, "file-b.txt"), "content from target")
    execSync("git add .", { cwd: targetAtom.cwd, stdio: "ignore" })
    execSync("git commit -m 'add file-b from target'", { cwd: targetAtom.cwd, stdio: "ignore" })
    
    // Merge source into target
    await pool.merge(sourceAtom, targetAtom)
    
    // Target 应该同时有 file-a.txt 和 file-b.txt
    assert.ok(existsSync(join(targetAtom.cwd, "file-a.txt")), "file-a should exist in target")
    assert.ok(existsSync(join(targetAtom.cwd, "file-b.txt")), "file-b should exist in target")
    assert.equal(
      readFileSync(join(targetAtom.cwd, "file-a.txt"), "utf8"),
      "content from source",
      "file-a should have source content"
    )
    
    pool.release(sourceAtom)
    pool.release(targetAtom)
  })

  it("merge preserves all commits from source", async () => {
    const sourceAtom = await pool.acquire()
    const targetAtom = await pool.acquire()
    
    // Source: 3 个提交
    writeFileSync(join(sourceAtom.cwd, "commit1.txt"), "1")
    execSync("git add . && git commit -m 'commit 1'", { cwd: sourceAtom.cwd, stdio: "ignore" })
    
    writeFileSync(join(sourceAtom.cwd, "commit2.txt"), "2")
    execSync("git add . && git commit -m 'commit 2'", { cwd: sourceAtom.cwd, stdio: "ignore" })
    
    writeFileSync(join(sourceAtom.cwd, "commit3.txt"), "3")
    execSync("git add . && git commit -m 'commit 3'", { cwd: sourceAtom.cwd, stdio: "ignore" })
    
    await pool.merge(sourceAtom, targetAtom)
    
    // Target 应该有所有 3 个文件
    assert.ok(existsSync(join(targetAtom.cwd, "commit1.txt")))
    assert.ok(existsSync(join(targetAtom.cwd, "commit2.txt")))
    assert.ok(existsSync(join(targetAtom.cwd, "commit3.txt")))
    
    pool.release(sourceAtom)
    pool.release(targetAtom)
  })

  it("merge creates merge commit", async () => {
    const sourceAtom = await pool.acquire()
    const targetAtom = await pool.acquire()
    
    writeFileSync(join(sourceAtom.cwd, "source.txt"), "source")
    execSync("git add . && git commit -m 'source commit'", { cwd: sourceAtom.cwd, stdio: "ignore" })
    
    writeFileSync(join(targetAtom.cwd, "target.txt"), "target")
    execSync("git add . && git commit -m 'target commit'", { cwd: targetAtom.cwd, stdio: "ignore" })
    
    await pool.merge(sourceAtom, targetAtom)
    
    // 检查是否有 merge commit
    const log = execSync("git log --oneline -5", { cwd: targetAtom.cwd, encoding: "utf8" })
    
    // 应该有 merge commit（通常包含 "Merge" 字样）
    assert.ok(log.includes("merge") || log.includes("Merge"), "Should have merge commit")
    
    pool.release(sourceAtom)
    pool.release(targetAtom)
  })
})
