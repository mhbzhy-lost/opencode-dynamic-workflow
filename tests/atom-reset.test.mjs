/**
 * T3.2: Atom Reset Tests
 * 
 * Tests atom reset functionality:
 * - Worker reset command handling
 * - Pool reset method
 * - Switching between branches
 * - Cleaning working directory
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { AtomPool } from "../lib/atom-pool.mjs"

describe("T3.2: Atom Reset", () => {
  let testRepo
  let pool

  before(async () => {
    // 创建新的 git 仓库
    testRepo = mkdtempSync(join(tmpdir(), "atom-reset-"))
    
    execSync("git init", { cwd: testRepo, stdio: "ignore" })
    execSync("git config user.email test@test.com", { cwd: testRepo, stdio: "ignore" })
    execSync("git config user.name Test", { cwd: testRepo, stdio: "ignore" })
    
    execSync("touch initial.txt", { cwd: testRepo, stdio: "ignore" })
    execSync("git add .", { cwd: testRepo, stdio: "ignore" })
    execSync("git commit -m 'init'", { cwd: testRepo, stdio: "ignore" })
    
    execSync("git branch branch-a", { cwd: testRepo, stdio: "ignore" })
    execSync("git branch branch-b", { cwd: testRepo, stdio: "ignore" })
    
    pool = new AtomPool(testRepo)
  })

  after(() => {
    pool.shutdown()
    execSync(`rm -rf ${testRepo}`, { stdio: "ignore" })
  })

  it("reset to branch-a should have correct files", async () => {
    const atom = await pool.acquire("branch-a")
    
    writeFileSync(join(atom.cwd, "file-a.txt"), "content-a")
    execSync("git add .", { cwd: atom.cwd, stdio: "ignore" })
    execSync("git commit -m 'add file a'", { cwd: atom.cwd, stdio: "ignore" })
    
    await pool.reset(atom, "branch-b")
    
    assert.ok(!existsSync(join(atom.cwd, "file-a.txt")), "file-a.txt should not exist after reset to branch-b")
    
    writeFileSync(join(atom.cwd, "file-b.txt"), "content-b")
    execSync("git add .", { cwd: atom.cwd, stdio: "ignore" })
    execSync("git commit -m 'add file b'", { cwd: atom.cwd, stdio: "ignore" })
    
    await pool.reset(atom, "branch-a")
    
    assert.ok(existsSync(join(atom.cwd, "file-a.txt")), "file-a.txt should exist after reset to branch-a")
    assert.ok(!existsSync(join(atom.cwd, "file-b.txt")), "file-b.txt should not exist after reset to branch-a")
    assert.equal(readFileSync(join(atom.cwd, "file-a.txt"), "utf8"), "content-a")
    
    pool.release(atom)
  })

  it("reset cleans untracked files", async () => {
    const atom = await pool.acquire("branch-a")
    
    writeFileSync(join(atom.cwd, "untracked.txt"), "untracked content")
    assert.ok(existsSync(join(atom.cwd, "untracked.txt")), "untracked file should exist")
    
    await pool.reset(atom, "branch-a")
    
    assert.ok(!existsSync(join(atom.cwd, "untracked.txt")), "untracked file should be cleaned")
    
    pool.release(atom)
  })

  it("reset preserves committed changes", async () => {
    const atom = await pool.acquire("branch-a")
    
    writeFileSync(join(atom.cwd, "committed.txt"), "committed content")
    execSync("git add .", { cwd: atom.cwd, stdio: "ignore" })
    execSync("git commit -m 'committed change'", { cwd: atom.cwd, stdio: "ignore" })
    
    writeFileSync(join(atom.cwd, "uncommitted.txt"), "uncommitted")
    
    await pool.reset(atom, "branch-a")
    
    assert.ok(existsSync(join(atom.cwd, "committed.txt")), "committed file should be preserved")
    assert.equal(readFileSync(join(atom.cwd, "committed.txt"), "utf8"), "committed content")
    assert.ok(!existsSync(join(atom.cwd, "uncommitted.txt")), "uncommitted file should be cleaned")
    
    pool.release(atom)
  })
})
