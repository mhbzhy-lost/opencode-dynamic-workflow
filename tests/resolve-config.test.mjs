import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { resolveWorkflowConfig } from "../lib/runner.mjs"

describe("resolveWorkflowConfig", () => {
  // ── Defaults ──
  it("returns safe defaults when no args and no user defaults", () => {
    const cfg = resolveWorkflowConfig([], {})
    assert.equal(cfg.openDashboard, false, "dashboard closed by default")
    assert.equal(cfg.dangerouslySkipPermissions, true, "permissions skipped by default")
    assert.equal(cfg.maxConcurrent, 4, "maxConcurrent default 4")
    assert.equal(cfg.positional.length, 0)
    assert.equal(cfg.model, undefined)
    assert.equal(cfg.baseUrl, undefined)
    assert.equal(cfg.workdir, undefined)
    assert.equal(cfg.resume, undefined)
  })

  it("user defaults override hard-coded defaults", () => {
    const cfg = resolveWorkflowConfig([], {
      openDashboard: true,
      dangerouslySkipPermissions: false,
      maxConcurrent: 8,
    })
    assert.equal(cfg.openDashboard, true)
    assert.equal(cfg.dangerouslySkipPermissions, false)
    assert.equal(cfg.maxConcurrent, 8)
  })

  // ── CLI parsing ──
  it("parses --model into model string", () => {
    const cfg = resolveWorkflowConfig(["--model", "anthropic/claude-sonnet-4-20250514"], {})
    assert.equal(cfg.model, "anthropic/claude-sonnet-4-20250514")
  })

  it("parses --base-url into baseUrl string", () => {
    const cfg = resolveWorkflowConfig(["--base-url", "http://localhost:4800"], {})
    assert.equal(cfg.baseUrl, "http://localhost:4800")
  })

  it("parses --workdir", () => {
    const cfg = resolveWorkflowConfig(["--workdir", "/tmp/wf"], {})
    assert.equal(cfg.workdir, "/tmp/wf")
  })

  it("parses --max-concurrent as number", () => {
    const cfg = resolveWorkflowConfig(["--max-concurrent", "12"], {})
    assert.equal(cfg.maxConcurrent, 12)
    assert.equal(typeof cfg.maxConcurrent, "number")
  })

  it("--no-dashboard overrides default openDashboard", () => {
    const cfg = resolveWorkflowConfig(["--no-dashboard"], { openDashboard: true })
    assert.equal(cfg.openDashboard, false)
  })

  it("--dashboard force-opens even when default false", () => {
    const cfg = resolveWorkflowConfig(["--dashboard"], {})
    assert.equal(cfg.openDashboard, true)
  })

  it("--skip-permissions and --no-skip-permissions toggle", () => {
    const a = resolveWorkflowConfig(["--skip-permissions"], { dangerouslySkipPermissions: false })
    assert.equal(a.dangerouslySkipPermissions, true)

    const b = resolveWorkflowConfig(["--no-skip-permissions"], {})
    assert.equal(b.dangerouslySkipPermissions, false)
  })

  it("--resume sets resume flag", () => {
    const cfg = resolveWorkflowConfig(["--resume"], {})
    assert.equal(cfg.resume, true)
  })

  // ── Positional / unknown args ──
  it("collects unknown args into .positional", () => {
    const cfg = resolveWorkflowConfig(
      ["--model", "foo/bar", "hello", "world", "--unknown", "value"],
      {},
    )
    assert.equal(cfg.model, "foo/bar")
    assert.deepEqual(cfg.positional, ["hello", "world", "--unknown", "value"])
  })

  // ── CLI overrides user defaults ──
  it("CLI flags override user defaults", () => {
    const cfg = resolveWorkflowConfig(
      ["--max-concurrent", "16", "--no-dashboard"],
      { maxConcurrent: 2, openDashboard: true },
    )
    assert.equal(cfg.maxConcurrent, 16)
    assert.equal(cfg.openDashboard, false)
  })

  // ── Mixed ──
  it("handles complex mix: CLI + defaults + positional", () => {
    const cfg = resolveWorkflowConfig(
      ["--model", "x/y", "--resume", "my question", "--skip-permissions"],
      { workdir: "/tmp/fallback", maxConcurrent: 6 },
    )
    assert.equal(cfg.model, "x/y")
    assert.equal(cfg.resume, true)
    assert.equal(cfg.dangerouslySkipPermissions, true)
    assert.equal(cfg.workdir, "/tmp/fallback")
    assert.equal(cfg.maxConcurrent, 6)
    assert.deepEqual(cfg.positional, ["my question"])
  })
})
