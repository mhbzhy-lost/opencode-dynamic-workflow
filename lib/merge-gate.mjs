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

  return { createNode, ensureAccumulator, consolidate, removeNode }
}
