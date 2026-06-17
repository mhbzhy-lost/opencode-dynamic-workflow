import { create, chooseAccumulator, consolidatePhase, remove } from "./worktree.mjs"

export function createWorktreeApi({ repoDir, baseBranch, exec }) {
  const wtRepoDir = repoDir
  const wtBaseBranch = baseBranch
  const wtExec = exec

  async function createNode(rDir, nodeId, bBranch) {
    const branch = `wf-${nodeId}`
    const state = await create({
      repoDir: rDir,
      branch,
      baseBranch: bBranch,
      exec: wtExec,
    })
    return state
  }

  async function ensureAccumulator(rDir, bBranch) {
    return chooseAccumulator(
      `${rDir}/.workflow`,
      bBranch,
      rDir,
      { exec: wtExec }
    )
  }

  async function consolidate(nodeDirs, accumulatorDir) {
    return consolidatePhase(nodeDirs, accumulatorDir, 1, {
      exec: wtExec,
      accBranch: `${wtBaseBranch}-acc`,
    })
  }

  async function removeNode(nodeDir) {
    return remove({
      path: nodeDir,
      repoDir: wtRepoDir,
      exec: wtExec,
    })
  }

  async function mergeAccumulator(accumulatorDir, baseBranch, opts = {}) {
    const exec = wtExec
    const accBranch = `${baseBranch}-acc`
    const rawId = opts.workflowId ? String(opts.workflowId) : ""
    const safeId = rawId.replace(/[^a-zA-Z0-9._-]/g, "_")
    const commitSuffix = safeId ? ` (${safeId})` : ""
    await exec("git", ["-C", accumulatorDir, "add", "."])
    await exec("git", ["-C", accumulatorDir, "commit", "-m", `workflow: final accumulator state${commitSuffix}`, "--allow-empty"])
    await exec("git", ["-C", wtRepoDir, "checkout", baseBranch])
    await exec("git", ["-C", wtRepoDir, "merge", "--no-ff", "-m", `workflow: merge accumulator into base${commitSuffix}`, accBranch])
  }

  return { createNode, ensureAccumulator, consolidate, removeNode, mergeAccumulator }
}
