import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, existsSync, readlinkSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const SCRIPT = join(ROOT, "install-opencode.sh")

function install(configDir) {
  return execFileSync("bash", [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, OPENCODE_CONFIG_DIR: configDir, NODE_BIN: "node" },
    timeout: 30000,
  })
}

describe("install-opencode.sh", () => {
  it("plugin 软链指向 submodule plugins/workflow-hint.js", () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-test-"))
    try {
      const out = install(tmp)
      assert.ok(out.includes("[ok]"))

      const link = join(tmp, "plugins", "workflow-hint.js")
      assert.ok(existsSync(link), `plugin symlink should exist: ${link}`)
      const target = readlinkSync(link)
      assert.ok(
        target.endsWith("opencode-dynamic-workflow/plugins/workflow-hint.js"),
        `unexpected target: ${target}`
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("skill 软链指向 submodule skills/workflow-usage", () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-test-"))
    try {
      install(tmp)
      const link = join(tmp, "skills", "workflow-usage")
      assert.ok(existsSync(link), `skill symlink should exist: ${link}`)
      const target = readlinkSync(link)
      assert.ok(
        target.endsWith("opencode-dynamic-workflow/skills/workflow-usage"),
        `unexpected target: ${target}`
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("重复执行 idempotent（第二次运行不报错，软链目标不变）", () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-test-"))
    try {
      install(tmp)
      const out2 = install(tmp)
      assert.ok(out2.includes("已存在且正确") || out2.includes("[next]"))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
