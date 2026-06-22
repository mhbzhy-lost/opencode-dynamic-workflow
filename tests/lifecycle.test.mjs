import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { AtomPool } from "../lib/atom-pool.mjs"

describe("T5.4: Lifecycle Tests", () => {
  let testRepo
  let pool

  beforeEach(() => {
    testRepo = mkdtempSync(join(tmpdir(), "lifecycle-"))
    execSync("git init", { cwd: testRepo, stdio: "ignore" })
    execSync("git config user.email test@test.com", { cwd: testRepo, stdio: "ignore" })
    execSync("git config user.name Test", { cwd: testRepo, stdio: "ignore" })
    execSync("echo init > README && git add . && GIT_AUTHOR_DATE='2020-01-01T00:00:00' GIT_COMMITTER_DATE='2020-01-01T00:00:00' git commit -m 'init'",
      { cwd: testRepo, stdio: "ignore" })

    mkdirSync(join(testRepo, ".workflow", "worktrees"), { recursive: true })
    pool = new AtomPool(testRepo)
  })

  afterEach(() => {
    pool.shutdown()
    rmSync(testRepo, { recursive: true, force: true })
  })

  it("idle pool size reflects released atoms", async () => {
    assert.equal(pool.idleCount, 0)

    const atom1 = await pool.acquire()
    const atom2 = await pool.acquire()
    assert.equal(pool.idleCount, 0)
    assert.equal(pool.busyCount, 2)

    pool.release(atom1)
    assert.equal(pool.idleCount, 1)
    assert.equal(pool.busyCount, 1)

    pool.release(atom2)
    assert.equal(pool.idleCount, 2)
    assert.equal(pool.busyCount, 0)
  })

  it("acquire reuses idle atoms before creating new ones", async () => {
    const atom1 = await pool.acquire()
    pool.release(atom1)
    const initialCount = pool.idleCount

    const atom2 = await pool.acquire()
    assert.equal(pool.idleCount, initialCount - 1)
    assert.equal(pool.busyCount, 1)
  })

  it("git clean removes untracked files after recycleAtom", async () => {
    const atom = await pool.acquire()
    const untrackedPath = join(atom.cwd, "untracked.txt")
    execSync(`echo "untracked" > ${untrackedPath}`, { cwd: atom.cwd })

    assert.equal(
      execSync(`test -f ${untrackedPath} && echo yes || echo no`, {
        cwd: atom.cwd,
        encoding: "utf8"
      }).trim(),
      "yes"
    )

    await pool.recycleAtom(atom)
    pool.release(atom)

    const atomNew = await pool.acquire()
    assert.equal(
      execSync(`test -f untracked.txt && echo yes || echo no`, {
        cwd: atomNew.cwd,
        encoding: "utf8"
      }).trim(),
      "no",
      "Untracked files should be cleaned"
    )
    pool.release(atomNew)
  })

  it("shutdown terminates all processes gracefully", async () => {
    const atom1 = await pool.acquire()
    const atom2 = await pool.acquire()
    const pid1 = atom1.process.pid
    const pid2 = atom2.process.pid

    assert.ok(execSync(`ps -p ${pid1} && echo alive`, { encoding: "utf8" }).includes("alive"))
    assert.ok(execSync(`ps -p ${pid2} && echo alive`, { encoding: "utf8" }).includes("alive"))

    pool.shutdown()

    await new Promise(r => setTimeout(r, 500))

    const proc1Alive = execSync(`ps -p ${pid1} 2>/dev/null || echo dead`, { encoding: "utf8" })
    const proc2Alive = execSync(`ps -p ${pid2} 2>/dev/null || echo dead`, { encoding: "utf8" })

    assert.ok(proc1Alive.includes("dead"))
    assert.ok(proc2Alive.includes("dead"))
  })

  it("cross-DAG replay works by resetting worktrees", async () => {
    const atom = await pool.acquire()
    const filePath = join(atom.cwd, "test.txt")
    execSync(`echo "first" > ${filePath}`, { cwd: atom.cwd })
    execSync("git add . && git commit -m 'first'", { cwd: atom.cwd, stdio: "ignore" })

    pool.release(atom)

    const atom2 = await pool.acquire()
    const result = execSync("git log --oneline -1", {
      cwd: atom2.cwd,
      encoding: "utf8"
    })

    assert.ok(result.includes("first"), "Should see commits from previous usage")

    pool.release(atom2)
  })
})
