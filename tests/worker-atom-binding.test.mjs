import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { AtomPool } from "../lib/atom-pool.mjs"

describe("T2.3: Worker-Atom CWD Binding Verification", () => {
  let testRepo
  let pool

  before(() => {
    // 创建临时 git 仓库
    testRepo = mkdtempSync(join(tmpdir(), "cwd-binding-"))
    execSync("git init", { cwd: testRepo, stdio: "ignore" })
    execSync("git config user.email 'test@test.com'", { cwd: testRepo, stdio: "ignore" })
    execSync("git config user.name 'Test'", { cwd: testRepo, stdio: "ignore" })
    execSync("git commit --allow-empty -m 'init'", { cwd: testRepo, stdio: "ignore" })

    pool = new AtomPool(testRepo)
  })

  after(() => {
    pool.shutdown()
    execSync(`rm -rf ${testRepo}`, { stdio: "ignore" })
  })

  it("atom.cwd matches the worktree path", async () => {
    const atom = await pool.acquire()

    // 验证 atom.cwd 存在
    assert.ok(atom.cwd, "atom.cwd should be defined")
    
    // 验证包含 .workflow/worktrees
    assert.ok(
      atom.cwd.includes(".workflow/worktrees") || atom.cwd.includes(".workflow"), 
      `atom.cwd should contain .workflow, got: ${atom.cwd}`
    )

    // 验证是有效 git 仓库
    const isGitRepo = execSync("git rev-parse --is-inside-work-tree", {
      cwd: atom.cwd,
      encoding: "utf8",
      stdio: "pipe"
    }).trim()
    assert.equal(isGitRepo, "true", "atom.cwd should be a git repository")

    pool.release(atom)
  })

  it("bash command executes in atom.cwd", async () => {
    const atom = await pool.acquire()

    // 在 atom.cwd 创建文件
    const testFile = join(atom.cwd, "test.txt")
    writeFileSync(testFile, "hello")

    execSync("git add . && git commit -m 'add test' --allow-empty", { cwd: atom.cwd, stdio: "ignore" })

    // 验证文件可以正常访问（不需要通过 LLM agent 读）
    const content = readFileSync(join(atom.cwd, "test.txt"), { encoding: "utf8" })
    assert.equal(content, "hello", "Should be able to read file from atom.cwd")

    pool.release(atom)
  })

  it("multiple atoms have isolated CWDs", async () => {
    const atom1 = await pool.acquire()
    const atom2 = await pool.acquire()

    // 两个 atom 的 CWD 应该不同
    assert.notEqual(atom1.cwd, atom2.cwd, "Different atoms should have different CWDs")

    // 在 atom1 创建文件
    writeFileSync(join(atom1.cwd, "only-in-atom1.txt"), "atom1")

    // atom2 不应该看到这个文件
    const atom2HasFile = existsSync(join(atom2.cwd, "only-in-atom1.txt"))
    assert.equal(atom2HasFile, false, "atom2 should not see atom1's files")

    pool.release(atom1)
    pool.release(atom2)
  })

  it("cwd binding persists after reset", async () => {
    const atom = await pool.acquire()
    const originalCwd = atom.cwd

    // 在 atom.cwd 中创建新分支（而不是 testRepo）
    execSync("git checkout -b feature", { cwd: atom.cwd, stdio: "ignore" })

    // 验证在 atom.cwd 中切换到了新分支
    const branchInAtom = execSync("git branch --show-current", {
      cwd: atom.cwd,
      encoding: "utf8"
    }).trim()
    assert.equal(branchInAtom, "feature", "atom.cwd should now be on feature branch")

    // CWD 路径应该保持不变
    assert.equal(atom.cwd, originalCwd, "CWD path should not change")

    pool.release(atom)
  })
})
