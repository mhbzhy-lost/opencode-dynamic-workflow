#!/usr/bin/env node
/**
 * 示例 workflow：使用 atom pool + accumulator 的 DAG
 *
 * DAG 结构：
 *   A → B, A → C, B → D, C → D
 *
 * Ref 计数：
 *   A: 2（B 和 C 都依赖它）
 *   B: 1（D 依赖它）
 *   C: 1（D 依赖它）
 *   D: 0（无下游）
 *
 * 晋升策略：
 *   - A 完成后，B 和 C 同时 ready
 *   - B 优先晋升：ref 2→1，fork（因为 ref>1）
 *   - C 随后晋升：ref 1→0，inherit（最后一个使用者）
 *   - B 和 C 都完成后，D ready
 *   - D 晋升：acquire（多个依赖），merge B 到 C
 */
import { createWorkflow } from "../lib/runner.mjs"
import { resolveWorkflowConfig } from "../lib/runner.mjs"
import { execSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function main() {
  // 创建临时 git 仓库
  const repo = mkdtempSync(join(tmpdir(), "example-"))
  execSync("git init", { cwd: repo, stdio: "ignore" })
  execSync("git config user.email test@test.com", { cwd: repo, stdio: "ignore" })
  execSync("git config user.name Test", { cwd: repo, stdio: "ignore" })
  execSync("echo init > README && git add . && git commit -m 'init'", {
    cwd: repo, stdio: "ignore"
  })

  const config = resolveWorkflowConfig(process.argv.slice(2), {
    workdir: ".workflow",
    worktree: {
      enable: true,
      repoDir: repo,
      baseBranch: "main",
      autoMerge: true
    }
  })

  const wf = await createWorkflow(config)

  await wf.dag([
    {
      id: "A",
      deps: [],
      type: "general",
      prompt: "Create a file called base.txt with content 'base content\\n' and commit it."
    },
    {
      id: "B",
      deps: ["A"],
      type: "general",
      prompt: "Append 'feature B\\n' to base.txt and commit."
    },
    {
      id: "C",
      deps: ["A"],
      type: "general",
      prompt: "Append 'feature C\\n' to base.txt and commit."
    },
    {
      id: "D",
      deps: ["B", "C"],
      type: "general",
      prompt: "Create final.txt with the combined content of base.txt and commit."
    }
  ])

  await wf.shutdown()
  
  // 清理临时目录
  rmSync(repo, { recursive: true, force: true })

  console.log("\n✅ Workflow completed successfully!")
  console.log("Atom pool managed worktrees efficiently through promotion.")
}

main().catch(err => {
  console.error("Workflow failed:", err)
  process.exit(1)
})
