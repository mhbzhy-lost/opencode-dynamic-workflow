import { describe, it } from "node:test"
import assert from "node:assert/strict"

// ---------------------------------------------------------------------------
// worktree.create
// ---------------------------------------------------------------------------
describe("worktree.create", () => {
  it("runs git worktree add -b <branch> <path> <base> and infers path from repoDir", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      return Promise.resolve("")
    }

    const { create } = await import("../lib/worktree.mjs")
    const state = await create({
      repoDir: "/repo",
      branch: "wf-001",
      baseBranch: "main",
      exec,
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], "git")
    assert.deepEqual(calls[0][1], [
      "-C", "/repo",
      "worktree", "add", "-b", "wf-001",
      "/repo/.workflow/wf-001",
      "main",
    ])
    assert.equal(state.path, "/repo/.workflow/wf-001")
    assert.equal(state.branch, "wf-001")
    assert.equal(state.repoDir, "/repo")
  })

  it("throws a clear error when git worktree add fails", async () => {
    const exec = () => Promise.reject(new Error("branch wf-001 already exists"))
    const { create } = await import("../lib/worktree.mjs")

    await assert.rejects(
      () => create({ repoDir: "/repo", branch: "wf-001", baseBranch: "main", exec }),
      /git worktree add failed.*branch wf-001 already exists/
    )
  })
})

// ---------------------------------------------------------------------------
// worktree branch name validation
// ---------------------------------------------------------------------------
describe("worktree branch validation", () => {
  it("accepts valid branch names like wf-001", async () => {
    const exec = () => Promise.resolve("")
    const { create } = await import("../lib/worktree.mjs")
    const state = await create({ repoDir: "/repo", branch: "wf-001", baseBranch: "main", exec })
    assert.equal(state.branch, "wf-001")
  })

  it("accepts valid branch names like feature/a.b", async () => {
    const exec = () => Promise.resolve("")
    const { create } = await import("../lib/worktree.mjs")
    const state = await create({ repoDir: "/repo", branch: "feature/a.b", baseBranch: "main", exec })
    assert.equal(state.branch, "feature/a.b")
  })

  it("rejects branch starting with --", async () => {
    const exec = () => Promise.resolve("")
    const { create } = await import("../lib/worktree.mjs")
    await assert.rejects(
      () => create({ repoDir: "/repo", branch: "--foo", baseBranch: "main", exec }),
      /invalid branch name/
    )
  })

  it("rejects branch with spaces", async () => {
    const exec = () => Promise.resolve("")
    const { create } = await import("../lib/worktree.mjs")
    await assert.rejects(
      () => create({ repoDir: "/repo", branch: "foo bar", baseBranch: "main", exec }),
      /invalid branch name/
    )
  })

  it("rejects branch with path traversal", async () => {
    const exec = () => Promise.resolve("")
    const { create } = await import("../lib/worktree.mjs")
    await assert.rejects(
      () => create({ repoDir: "/repo", branch: "../etc/passwd", baseBranch: "main", exec }),
      /invalid branch name/
    )
  })

  it("rejects empty branch name", async () => {
    const exec = () => Promise.resolve("")
    const { create } = await import("../lib/worktree.mjs")
    await assert.rejects(
      () => create({ repoDir: "/repo", branch: "", baseBranch: "main", exec }),
      /invalid branch name/
    )
  })

  it("rejects invalid baseBranch in chooseAccumulator", async () => {
    const exec = (cmd, args) => {
      if (args.includes("list")) return Promise.resolve("worktree /repo\nbranch refs/heads/main\n\n")
      return Promise.resolve("")
    }
    const { chooseAccumulator } = await import("../lib/worktree.mjs")
    await assert.rejects(
      () => chooseAccumulator("/repo/.workflow", "--bad", "/repo", { exec }),
      /invalid branch name/
    )
  })
})

// ---------------------------------------------------------------------------
// worktree.remove
// ---------------------------------------------------------------------------
describe("worktree.remove", () => {
  it("calls git worktree remove --force", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      return Promise.resolve("")
    }
    const { remove } = await import("../lib/worktree.mjs")

    await remove({
      path: "/repo/.workflow/wf-001",
      repoDir: "/repo",
      exec,
    })

    assert.equal(calls[0][0], "git")
    assert.deepEqual(calls[0][1], [
      "-C", "/repo",
      "worktree", "remove", "--force", "/repo/.workflow/wf-001",
    ])
  })

  it("falls back to rm -rf if git worktree remove fails", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      if (args.includes("remove")) return Promise.reject(new Error("not found"))
      return Promise.resolve("")
    }
    const { remove } = await import("../lib/worktree.mjs")

    await remove({ path: "/repo/.workflow/wf-001", repoDir: "/repo", exec })

    // first attempt failed
    assert.ok(calls[0][1].includes("worktree"))
    assert.ok(calls[0][1].includes("remove"))
    // fallback
    assert.equal(calls[1][0], "rm")
    assert.deepEqual(calls[1][1], ["-rf", "/repo/.workflow/wf-001"])
  })
})

// ---------------------------------------------------------------------------
// worktree.report — used by workflow to include merge-ready info in output
// ---------------------------------------------------------------------------
describe("worktree.report", () => {
  it("returns { branch, path, commitAhead, files } by parsing git log + status", async () => {
    const exec = (cmd, args) => {
      if (args.includes("log")) {
        return Promise.resolve("abc1234 fix: foo\ndef5678 feat: bar\n")
      }
      if (args.includes("status")) {
        return Promise.resolve(" M src/a.js\n?? src/b.js\n")
      }
      return Promise.resolve("")
    }

    const { report } = await import("../lib/worktree.mjs")
    const state = {
      path: "/repo/.workflow/wf-001",
      repoDir: "/repo",
      branch: "wf-001",
      baseBranch: "main",
    }

    const r = await report(state, { exec })

    assert.equal(r.branch, "wf-001")
    assert.equal(r.path, "/repo/.workflow/wf-001")
    assert.equal(r.commitAhead, 2)
    assert.deepEqual(r.files, [" M src/a.js", "?? src/b.js"])
  })

  it("reports commitAhead=0 when branch has no commits ahead", async () => {
    const exec = (cmd, args) => {
      if (args.includes("log")) return Promise.resolve("")
      if (args.includes("status")) return Promise.resolve("")
      return Promise.resolve("")
    }
    const { report } = await import("../lib/worktree.mjs")
    const state = { path: "/p", repoDir: "/repo", branch: "wf", baseBranch: "main" }

    const r = await report(state, { exec })

    assert.equal(r.commitAhead, 0)
    assert.deepEqual(r.files, [])
  })
})

// ---------------------------------------------------------------------------
// worktree.mergeInstructions — human-readable text for main agent
// ---------------------------------------------------------------------------
describe("worktree.mergeInstructions", () => {
  it("returns a multi-line string the main agent can follow", async () => {
    const exec = (cmd, args) => {
      if (args.includes("log")) return Promise.resolve("abc1234 fix\n")
      if (args.includes("status")) return Promise.resolve("")
      return Promise.resolve("")
    }
    const { mergeInstructions } = await import("../lib/worktree.mjs")
    const state = { path: "/p", repoDir: "/repo", branch: "wf-001", baseBranch: "main" }

    const text = await mergeInstructions(state, { exec })

    assert.ok(text.includes("wf-001"))
    assert.ok(text.includes("main"))
    assert.ok(text.includes("merge"))
    assert.ok(text.includes("conflict"))      // warns about conflicts
    assert.ok(text.includes("worktree remove")) // cleanup step
  })
})

// ---------------------------------------------------------------------------
// worktree.chooseAccumulator
// ---------------------------------------------------------------------------
describe("worktree.chooseAccumulator", () => {
  it("creates an accumulator worktree when none exists", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      if (args.includes("list")) return Promise.resolve("worktree /repo/.workflow\nbranch refs/heads/main\n\n")
      return Promise.resolve("")
    }

    const { chooseAccumulator } = await import("../lib/worktree.mjs")
    const result = await chooseAccumulator("/repo/.workflow", "main", "/repo", { exec })

    assert.equal(result, "/repo/.workflow/accumulator")
    const addCall = calls.find(([, a]) => a.includes("worktree") && a.includes("add"))
    assert.ok(addCall, "should call git worktree add")
    assert.deepEqual(addCall[1], [
      "-C", "/repo",
      "worktree", "add", "-b", "main-acc",
      "/repo/.workflow/accumulator",
      "main",
    ])
  })

  it("returns existing path when accumulator worktree already exists", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      if (args.includes("list")) {
        return Promise.resolve(
          "worktree /repo\nbranch refs/heads/main\n\nworktree /repo/.workflow/accumulator\nbranch refs/heads/main-acc\n\n"
        )
      }
      return Promise.resolve("")
    }

    const { chooseAccumulator } = await import("../lib/worktree.mjs")
    const result = await chooseAccumulator("/repo/.workflow", "main", "/repo", { exec })

    assert.equal(result, "/repo/.workflow/accumulator")
    const addCall = calls.find(([, a]) => a.includes("worktree") && a.includes("add"))
    assert.ok(!addCall, "should NOT call git worktree add when accumulator exists")
  })

  it("throws when worktree creation fails", async () => {
    const exec = (cmd, args) => {
      if (args.includes("list")) return Promise.resolve("worktree /repo\nbranch refs/heads/main\n\n")
      return Promise.reject(new Error("fatal: branch already exists"))
    }

    const { chooseAccumulator } = await import("../lib/worktree.mjs")
    await assert.rejects(
      () => chooseAccumulator("/repo/.workflow", "main", "/repo", { exec }),
      /accumulator worktree creation failed/
    )
  })
})

// ---------------------------------------------------------------------------
// worktree.consolidatePhase
// ---------------------------------------------------------------------------
describe("worktree.consolidatePhase", () => {
  it("commits and merges each workstream into the accumulator", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args.join ? args.join(" ") : args])
      return Promise.resolve("")
    }

    const { consolidatePhase } = await import("../lib/worktree.mjs")
    const result = await consolidatePhase(
      ["/repo/.workflow/wt-A", "/repo/.workflow/wt-B"],
      "/repo/.workflow/accumulator",
      1,
      { exec, accBranch: "main-acc" }
    )

    assert.deepEqual(result.conflicts, [])
    assert.equal(result.merged.length, 2)
    assert.equal(result.merged[0], "wt-A")
    assert.equal(result.merged[1], "wt-B")

    const adds = calls.filter(([, a]) => a.includes("add ."))
    assert.equal(adds.length, 2, "git add . for each workstream")

    const commits = calls.filter(([, a]) => a.includes("commit"))
    assert.equal(commits.length, 2, "git commit for each workstream")
    assert.ok(commits[0][1].includes("phase-1"), "commit message includes phase number")

    const merges = calls.filter(([, a]) => a.includes("merge") && a.includes("--no-ff"))
    assert.equal(merges.length, 2, "git merge --no-ff for each workstream into accumulator")
  })

  it("reports merge conflicts without crashing", async () => {
    const calls = []
    const exec = (cmd, args) => {
      const joined = args.join ? args.join(" ") : args
      calls.push([cmd, joined])
      if (joined.includes("merge") && joined.includes("--no-ff") && joined.includes("wt-B")) {
        return Promise.reject(new Error("CONFLICT (content): Merge conflict"))
      }
      return Promise.resolve("")
    }

    const { consolidatePhase } = await import("../lib/worktree.mjs")
    const result = await consolidatePhase(
      ["/repo/.workflow/wt-A", "/repo/.workflow/wt-B"],
      "/repo/.workflow/accumulator",
      1,
      { exec, accBranch: "main-acc" }
    )

    assert.equal(result.merged.length, 1)
    assert.equal(result.merged[0], "wt-A")
    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0].workstream, "wt-B")
    assert.ok(result.conflicts[0].message.includes("CONFLICT"))
  })

  it("includes --allow-empty so commit succeeds even when staging area is empty", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args.join ? args.join(" ") : args])
      return Promise.resolve("")
    }

    const { consolidatePhase } = await import("../lib/worktree.mjs")
    await consolidatePhase(
      ["/repo/.workflow/wt-A"],
      "/repo/.workflow/accumulator",
      1,
      { exec, accBranch: "main-acc" }
    )

    const commitCall = calls.find(([, a]) => a.includes("commit") && !a.includes("merge"))
    assert.ok(commitCall, "commit call should exist")
    assert.ok(
      commitCall[1].includes("--allow-empty"),
      `commit should include --allow-empty flag, got: ${commitCall[1]}`
    )
  })
})

// ---------------------------------------------------------------------------
// worktree.removeAccumulator
// ---------------------------------------------------------------------------
describe("worktree.removeAccumulator", () => {
  it("removes the worktree and deletes the branch", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      if (args.includes("--show-current")) return Promise.resolve("main-acc\n")
      return Promise.resolve("")
    }

    const { removeAccumulator } = await import("../lib/worktree.mjs")
    await removeAccumulator("/repo/.workflow/accumulator", { exec, repoDir: "/repo" })

    const removeCall = calls.find(([, a]) => a.includes("worktree") && a.includes("remove"))
    assert.ok(removeCall, "should call git worktree remove")
    assert.deepEqual(removeCall[1], [
      "-C", "/repo",
      "worktree", "remove", "--force", "/repo/.workflow/accumulator",
    ])

    const branchDel = calls.find(([, a]) => a.includes("branch") && a.includes("-D"))
    assert.ok(branchDel, "should call git branch -D")
    assert.deepEqual(branchDel[1], ["-C", "/repo", "branch", "-D", "main-acc"])
  })

  it("falls back to rm -rf when git worktree remove fails", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      if (args.includes("--show-current")) return Promise.resolve("main-acc\n")
      if (args.includes("worktree") && args.includes("remove")) return Promise.reject(new Error("not found"))
      return Promise.resolve("")
    }

    const { removeAccumulator } = await import("../lib/worktree.mjs")
    await removeAccumulator("/repo/.workflow/accumulator", { exec, repoDir: "/repo" })

    const rmCall = calls.find(([c]) => c === "rm")
    assert.ok(rmCall, "should fall back to rm -rf")
    assert.deepEqual(rmCall[1], ["-rf", "/repo/.workflow/accumulator"])
  })
})

// ---------------------------------------------------------------------------
// worktree.recycleAtom — clean atom before returning to idle pool
// ---------------------------------------------------------------------------
describe("worktree.recycleAtom", () => {
  it("stages, commits, detaches, and cleans atom", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      return Promise.resolve("")
    }

    const { recycleAtom } = await import("../lib/worktree.mjs")
    await recycleAtom({
      atomPath: "/repo/.workflow/atom-1",
      exec,
    })

    // Should stage all changes
    const addCall = calls.find(([, a]) => a.includes("add") && a.includes("-A"))
    assert.ok(addCall, "should call git add -A")
    assert.deepEqual(addCall[1], ["-C", "/repo/.workflow/atom-1", "add", "-A"])

    // Should commit with --allow-empty
    const commitCall = calls.find(([, a]) => a.includes("commit"))
    assert.ok(commitCall, "should call git commit")
    assert.ok(commitCall[1].includes("--allow-empty"), "commit should include --allow-empty")
    assert.deepEqual(commitCall[1], [
      "-C", "/repo/.workflow/atom-1",
      "commit", "--allow-empty", "-m", "recycle: atom cleanup"
    ])

    // Should detach HEAD
    const detachCall = calls.find(([, a]) => a.includes("checkout") && a.includes("--detach"))
    assert.ok(detachCall, "should call git checkout --detach")
    assert.deepEqual(detachCall[1], ["-C", "/repo/.workflow/atom-1", "checkout", "--detach"])

    // Should clean working directory
    const cleanCall = calls.find(([, a]) => a.includes("clean"))
    assert.ok(cleanCall, "should call git clean")
    assert.deepEqual(cleanCall[1], ["-C", "/repo/.workflow/atom-1", "clean", "-fdx"])
  })

  it("continues cleanup even when commit fails", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      if (args.includes("commit")) return Promise.reject(new Error("nothing to commit"))
      return Promise.resolve("")
    }

    const { recycleAtom } = await import("../lib/worktree.mjs")
    await recycleAtom({
      atomPath: "/repo/.workflow/atom-2",
      exec,
    })

    // Should still detach and clean even if commit failed
    const detachCall = calls.find(([, a]) => a.includes("checkout") && a.includes("--detach"))
    assert.ok(detachCall, "should still detach HEAD")

    const cleanCall = calls.find(([, a]) => a.includes("clean"))
    assert.ok(cleanCall, "should still clean working directory")
  })

  it("uses provided commit message", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      return Promise.resolve("")
    }

    const { recycleAtom } = await import("../lib/worktree.mjs")
    await recycleAtom({
      atomPath: "/repo/.workflow/atom-3",
      commitMessage: "task-001: completed",
      exec,
    })

    const commitCall = calls.find(([, a]) => a.includes("commit"))
    assert.ok(commitCall[1].includes("task-001: completed"), "should use provided commit message")
  })
})

// ---------------------------------------------------------------------------
// worktree.reset — switch atom to target state for reuse
// ---------------------------------------------------------------------------
describe("worktree.reset", () => {
  it("checks out existing branch when targetState is branch name", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      return Promise.resolve("")
    }

    const { reset } = await import("../lib/worktree.mjs")
    await reset({
      atomPath: "/repo/.workflow/atom-1",
      targetState: "wf-task-001",
      exec,
    })

    // Should checkout the branch
    const checkoutCall = calls.find(([, a]) => a.includes("checkout") && !a.includes("-b"))
    assert.ok(checkoutCall, "should call git checkout")
    assert.deepEqual(checkoutCall[1], ["-C", "/repo/.workflow/atom-1", "checkout", "wf-task-001"])

    // Should clean working directory
    const cleanCall = calls.find(([, a]) => a.includes("clean"))
    assert.ok(cleanCall, "should call git clean")
    assert.deepEqual(cleanCall[1], ["-C", "/repo/.workflow/atom-1", "clean", "-fdx"])
  })

  it("checks out commit SHA then creates new branch", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      return Promise.resolve("")
    }

    const { reset } = await import("../lib/worktree.mjs")
    await reset({
      atomPath: "/repo/.workflow/atom-2",
      targetState: "abc123def456",  // commit SHA
      newBranch: "wf-task-002",
      exec,
    })

    // Should checkout the commit (detached HEAD)
    const checkoutCommit = calls.find(([, a]) => 
      a.includes("checkout") && a.includes("abc123def456") && !a.includes("-b")
    )
    assert.ok(checkoutCommit, "should checkout commit SHA")
    assert.deepEqual(checkoutCommit[1], ["-C", "/repo/.workflow/atom-2", "checkout", "abc123def456"])

    // Should create new branch from that commit
    const createBranch = calls.find(([, a]) => a.includes("checkout") && a.includes("-b"))
    assert.ok(createBranch, "should create new branch")
    assert.deepEqual(createBranch[1], ["-C", "/repo/.workflow/atom-2", "checkout", "-b", "wf-task-002"])

    // Should clean working directory
    const cleanCall = calls.find(([, a]) => a.includes("clean"))
    assert.ok(cleanCall, "should call git clean")
  })

  it("resets to baseBranch when no targetState provided", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      return Promise.resolve("")
    }

    const { reset } = await import("../lib/worktree.mjs")
    await reset({
      atomPath: "/repo/.workflow/atom-3",
      baseBranch: "main",
      exec,
    })

    const checkoutCall = calls.find(([, a]) => a.includes("checkout") && !a.includes("-b"))
    assert.ok(checkoutCall, "should call git checkout")
    assert.deepEqual(checkoutCall[1], ["-C", "/repo/.workflow/atom-3", "checkout", "main"])
  })

  it("validates branch names before checkout", async () => {
    const exec = () => Promise.resolve("")
    const { reset } = await import("../lib/worktree.mjs")

    await assert.rejects(
      () => reset({
        atomPath: "/repo/.workflow/atom-4",
        newBranch: "--invalid",
        exec,
      }),
      /invalid branch name/
    )
  })

  it("cleans working directory even when checkout fails", async () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, args])
      if (args.includes("checkout")) return Promise.reject(new Error("pathspec did not match"))
      return Promise.resolve("")
    }

    const { reset } = await import("../lib/worktree.mjs")
    await reset({
      atomPath: "/repo/.workflow/atom-5",
      targetState: "nonexistent-branch",
      exec,
    })

    // Should still clean even if checkout failed
    const cleanCall = calls.find(([, a]) => a.includes("clean"))
    assert.ok(cleanCall, "should call git clean even when checkout fails")
  })
})
