import { execFile } from "node:child_process"
import { promisify } from "node:util"

const defaultExec = promisify(execFile)

function validateBranch(branch) {
  if (!branch || !/^[a-zA-Z0-9._/-]+$/.test(branch)) {
    throw new Error(`invalid branch name: ${JSON.stringify(branch)}`)
  }
  if (branch.startsWith("-")) {
    throw new Error(`invalid branch name: ${JSON.stringify(branch)}`)
  }
  if (branch.includes("..")) {
    throw new Error(`invalid branch name: ${JSON.stringify(branch)}`)
  }
}

async function run(cmd, args, exec) {
  const fn = exec || defaultExec
  const result = await fn(cmd, args)
  if (typeof result === "string") return result
  return result?.stdout ?? ""
}

export async function create({ repoDir, branch, baseBranch, exec }) {
  validateBranch(branch)
  validateBranch(baseBranch)
  const path = `${repoDir}/.workflow/${branch}`
  try {
    await run(
      "git",
      ["-C", repoDir, "worktree", "add", "-b", branch, path, baseBranch],
      exec
    )
  } catch (err) {
    throw new Error(`git worktree add failed: ${err.message}`)
  }
  return { path, branch, repoDir, baseBranch }
}

export async function remove({ path, repoDir, exec }) {
  try {
    await run(
      "git",
      ["-C", repoDir, "worktree", "remove", "--force", path],
      exec
    )
  } catch {
    await run("rm", ["-rf", path], exec)
  }
}

export async function report(state, { exec } = {}) {
  const { path, repoDir, branch, baseBranch } = state
  const logOut = await run(
    "git",
    ["-C", repoDir, "log", `${baseBranch}..${branch}`, "--oneline"],
    exec
  )
  const logLines = logOut.split("\n").filter((line) => line.length > 0)
  const commitAhead = logLines.length

  const statusOut = await run(
    "git",
    ["-C", path, "status", "--porcelain"],
    exec
  )
  const files = statusOut.split("\n").filter((line) => line.length > 0)

  return { branch, path, commitAhead, files }
}

export async function chooseAccumulator(workstreamsDir, baseBranch = "main", repoDir = ".", { exec } = {}) {
  validateBranch(baseBranch)
  const accPath = `${workstreamsDir}/accumulator`
  const accBranch = `${baseBranch}-acc`

  const listOut = await run(
    "git",
    ["-C", repoDir, "worktree", "list", "--porcelain"],
    exec
  )
  if (listOut.includes(accPath)) return accPath

  try {
    await run(
      "git",
      ["-C", repoDir, "worktree", "add", "-b", accBranch, accPath, baseBranch],
      exec
    )
  } catch (err) {
    throw new Error(`accumulator worktree creation failed: ${err.message}`)
  }
  return accPath
}

export async function consolidatePhase(workstreamDirs, accumulatorDir, phase, { exec, accBranch = "main-acc" } = {}) {
  const merged = []
  const conflicts = []

  for (const dir of workstreamDirs) {
    const name = dir.split("/").pop()
    const branch = name

    await run("git", ["-C", dir, "add", "."], exec)
    await run("git", ["-C", dir, "commit", "--allow-empty", "-m", `phase-${phase}: ${name}`], exec)

    try {
      await run(
        "git",
        ["-C", accumulatorDir, "merge", branch, "--no-ff", "-m", `consolidate phase-${phase} into ${name}`],
        exec
      )
      merged.push(name)
    } catch (err) {
      conflicts.push({ workstream: name, message: err.message })
    }
  }

  return { merged, conflicts }
}

export async function removeAccumulator(accumulatorDir, { exec, repoDir } = {}) {
  const branch = (
    await run("git", ["-C", accumulatorDir, "branch", "--show-current"], exec)
  ).trim()

  const repo = repoDir || "."
  try {
    await run(
      "git",
      ["-C", repo, "worktree", "remove", "--force", accumulatorDir],
      exec
    )
  } catch {
    await run("rm", ["-rf", accumulatorDir], exec)
  }

  if (branch) {
    try {
      await run("git", ["-C", repo, "branch", "-D", branch], exec)
    } catch {}
  }
}

export async function mergeInstructions(state, { exec } = {}) {
  const rep = await report(state, { exec })
  const { branch, baseBranch, path } = state
  const dirty = rep.files.length
    ? `Dirty files:\n${rep.files.map((f) => `  ${f}`).join("\n")}`
    : ""

  return [
    `## Worktree ready to merge`,
    ``,
    `Worktree path : ${path}`,
    `Branch        : ${branch}`,
    `Base branch   : ${baseBranch}`,
    `Commits ahead : ${rep.commitAhead}`,
    dirty,
    ``,
    `### Steps for the main agent`,
    ``,
    `1. Switch to base branch:`,
    `   \`\`\`bash`,
    `   git checkout ${baseBranch}`,
    `   \`\`\``,
    `2. Merge the worktree branch:`,
    `   \`\`\`bash`,
    `   git merge ${branch}`,
    `   \`\`\``,
    `3. If there is a **conflict**, resolve it (use LLM judgement), then:`,
    `   \`\`\`bash`,
    `   git add . && git merge --continue`,
    `   \`\`\``,
    `4. Remove the worktree and delete the branch:`,
    `   \`\`\`bash`,
    `   git worktree remove --force ${path}`,
    `   git branch -d ${branch}`,
    `   \`\`\``,
    ``,
    `**Do NOT touch the worktree until this step.** Subagents may still be`,
    `writing to it while the workflow runs.`,
  ]
    .filter((line) => line !== "")
    .join("\n")
}
