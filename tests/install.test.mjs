import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, existsSync, readlinkSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const SCRIPT = join(ROOT, "install-opencode.sh")

function install(configDir, agentsSkillsDir, fakeZshrc) {
  return execFileSync("bash", [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: configDir,
      AGENTS_SKILLS_DIR: agentsSkillsDir,
      ZSHRC: fakeZshrc,
      NODE_BIN: "node",
    },
    timeout: 30000,
  })
}

describe("install-opencode.sh", () => {
  it("skill 软链指向共享 ~/.agents/skills/workflow-usage", () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-test-"))
    const skillsDir = mkdtempSync(join(tmpdir(), "install-agents-skills-"))
    const home = mkdtempSync(join(tmpdir(), "install-home-"))
    const fakeZshrc = join(home, ".zshrc")
    try {
      install(tmp, skillsDir, fakeZshrc)
      const link = join(skillsDir, "workflow-usage")
      assert.ok(existsSync(link), `skill symlink should exist: ${link}`)
      const target = readlinkSync(link)
      assert.ok(
        target.endsWith("opencode-dynamic-workflow/skills/workflow-usage"),
        `unexpected target: ${target}`
      )
      assert.equal(existsSync(join(tmp, "skills", "workflow-usage")), false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(skillsDir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("重复执行 idempotent（第二次运行不报错，软链目标不变）", () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-test-"))
    const skillsDir = mkdtempSync(join(tmpdir(), "install-agents-skills-"))
    const home = mkdtempSync(join(tmpdir(), "install-home-"))
    const fakeZshrc = join(home, ".zshrc")
    try {
      install(tmp, skillsDir, fakeZshrc)
      const out2 = install(tmp, skillsDir, fakeZshrc)
      assert.ok(out2.includes("已存在且正确") || out2.includes("[next]"))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(skillsDir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("OPENCODE_WORKFLOW_ROOT 注册到 $ZSHRC", () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-test-"))
    const skillsDir = mkdtempSync(join(tmpdir(), "install-agents-skills-"))
    const home = mkdtempSync(join(tmpdir(), "install-home-"))
    const fakeZshrc = join(home, ".zshrc")
    writeFileSync(fakeZshrc, "")
    try {
      install(tmp, skillsDir, fakeZshrc)
      const rc = readFileSync(fakeZshrc, "utf8")
      assert.ok(
        rc.includes("export OPENCODE_WORKFLOW_ROOT="),
        `ZSHRC should contain OPENCODE_WORKFLOW_ROOT export, got:\n${rc}`
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(skillsDir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("原子写 .zshrc 保留已有内容", () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-test-"))
    const skillsDir = mkdtempSync(join(tmpdir(), "install-agents-skills-"))
    const home = mkdtempSync(join(tmpdir(), "install-home-"))
    const fakeZshrc = join(home, ".zshrc")
    const existingContent = "# my existing config\nalias ll='ls -la'\n"
    writeFileSync(fakeZshrc, existingContent)
    try {
      install(tmp, skillsDir, fakeZshrc)
      const rc = readFileSync(fakeZshrc, "utf8")
      assert.ok(
        rc.includes("# my existing config"),
        `ZSHRC should preserve existing content, got:\n${rc}`
      )
      assert.ok(
        rc.includes("alias ll='ls -la'"),
        `ZSHRC should preserve existing aliases, got:\n${rc}`
      )
      assert.ok(
        rc.includes("export OPENCODE_WORKFLOW_ROOT="),
        `ZSHRC should append new export, got:\n${rc}`
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(skillsDir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})
