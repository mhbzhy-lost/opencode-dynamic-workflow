import { describe, it } from "node:test"
import assert from "node:assert/strict"

describe("merge-gate.createWorktreeApi", () => {
  it("returns an object with createNode/consolidate/removeNode/ensureAccumulator", async () => {
    const { createWorktreeApi } = await import("../lib/merge-gate.mjs")
    const exec = () => Promise.resolve("")
    const api = createWorktreeApi({ repoDir: "/repo", baseBranch: "main", exec })

    assert.equal(typeof api.createNode, "function")
    assert.equal(typeof api.consolidate, "function")
    assert.equal(typeof api.removeNode, "function")
    assert.equal(typeof api.ensureAccumulator, "function")
  })

  it("createNode calls worktree.create with node-specific branch", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      return Promise.resolve("")
    }
    const { createWorktreeApi } = await import("../lib/merge-gate.mjs")
    const api = createWorktreeApi({ repoDir: "/repo", baseBranch: "main", exec })

    const wt = await api.createNode("/repo", "node-A", "main")

    assert.equal(wt.path, "/repo/.workflow/wf-node-A")
    assert.equal(wt.branch, "wf-node-A")
    const addCall = calls.find(([, a]) => a.includes("worktree") && a.includes("add"))
    assert.ok(addCall)
    assert.ok(addCall[1].includes("wf-node-A"))
  })

  it("ensureAccumulator delegates to worktree.chooseAccumulator", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      if (args.includes("list")) return Promise.resolve("worktree /repo\nbranch refs/heads/main\n\n")
      return Promise.resolve("")
    }
    const { createWorktreeApi } = await import("../lib/merge-gate.mjs")
    const api = createWorktreeApi({ repoDir: "/repo", baseBranch: "main", exec })

    const accPath = await api.ensureAccumulator("/repo", "main")

    assert.equal(accPath, "/repo/.workflow/accumulator")
  })

  it("consolidate commits and merges each nodeDir into accumulator", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args.join ? args.join(" ") : args])
      return Promise.resolve("")
    }
    const { createWorktreeApi } = await import("../lib/merge-gate.mjs")
    const api = createWorktreeApi({ repoDir: "/repo", baseBranch: "main", exec })

    const result = await api.consolidate(
      ["/repo/.workflow/node-A", "/repo/.workflow/node-B"],
      "/repo/.workflow/accumulator"
    )

    assert.deepEqual(result.conflicts, [])
    assert.equal(result.merged.length, 2)
  })

  it("removeNode cleans up a worktree directory", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      return Promise.resolve("")
    }
    const { createWorktreeApi } = await import("../lib/merge-gate.mjs")
    const api = createWorktreeApi({ repoDir: "/repo", baseBranch: "main", exec })

    await api.removeNode("/repo/.workflow/node-A")

    const removeCall = calls.find(([, a]) => a.includes("worktree") && a.includes("remove"))
    assert.ok(removeCall)
    assert.ok(removeCall[1].includes("/repo/.workflow/node-A"))
  })

  it("mergeAccumulator merges acc branch into baseBranch", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args.join ? args.join(" ") : args])
      return Promise.resolve("")
    }
    const { createWorktreeApi } = await import("../lib/merge-gate.mjs")
    const api = createWorktreeApi({ repoDir: "/repo", baseBranch: "main", exec })

    await api.mergeAccumulator("/repo/.workflow/accumulator", "main")

    const merged = calls.find(([, a]) => a.includes("merge") && a.includes("main-acc"))
    assert.ok(merged, "should merge main-acc into main")
    const checkout = calls.find(([, a]) => a.includes("checkout") && a.includes("main"))
    assert.ok(checkout, "should checkout main before merge")
  })

  it("mergeAccumulator includes workflow ID in commit message", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args.join ? args.join(" ") : args])
      return Promise.resolve("")
    }
    const { createWorktreeApi } = await import("../lib/merge-gate.mjs")
    const api = createWorktreeApi({ repoDir: "/repo", baseBranch: "main", exec })

    await api.mergeAccumulator("/repo/.workflow/accumulator", "main", { workflowId: "health-review-123" })

    const commitCall = calls.find(([, a]) => a.includes("commit") && a.includes("-m"))
    assert.ok(commitCall, "should commit")
    const commitMsg = Array.isArray(commitCall[1]) ? commitCall[1].join(" ") : commitCall[1]
    assert.ok(commitMsg.includes("health-review-123"), `commit message should include workflow ID, got: ${commitMsg}`)
  })
})
