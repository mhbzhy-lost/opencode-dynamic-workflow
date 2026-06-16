import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { renderDashboard } from "../lib/dashboard.mjs";

let esc, truncate;
try {
  ({ esc, truncate } = await import("../lib/dashboard.mjs"));
} catch {
  // exports may not exist yet — tests will fail with meaningful assertion
}

function makeTempWorkdir() {
  const workdir = mkdtempSync(join(tmpdir(), "dash-test-"));
  return workdir;
}

function makeStatus(overrides = {}) {
  return {
    state: "running",
    phase: 2,
    totalPhases: 5,
    startedAt: "2025-06-15T10:00:00.000Z",
    agents: {},
    ...overrides,
  };
}

describe("renderDashboard", () => {
  let workdir;

  beforeEach(() => {
    workdir = makeTempWorkdir();
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("generates HTML with meta refresh AND live JS timer", () => {
    renderDashboard(workdir, makeStatus());
    const html = readFileSync(join(workdir, "dashboard.html"), "utf-8");
    // Meta refresh reloads the file from disk (picks up regenerated content from 1s timer in runner)
    assert.ok(html.includes('<meta http-equiv="refresh" content="3">'));
    // JS timer updates duration cells in-browser each second (smooth between refreshes)
    assert.ok(html.includes("setInterval"));
    assert.ok(html.includes("data-started"));
  });

  it("embeds data-started on running agents for JS live duration", () => {
    const status = makeStatus({
      agents: {
        "a1": { status: "running", startedAt: "2025-06-15T10:05:00Z" },
        "a2": { status: "completed", startedAt: "2025-06-15T10:00:00Z", finishedAt: "2025-06-15T10:05:00Z", durationMs: 300000 },
      },
    });
    renderDashboard(workdir, status);
    const html = readFileSync(join(workdir, "dashboard.html"), "utf-8");
    assert.ok(html.includes('data-started="2025-06-15T10:05:00Z"'), "running agent should have data-started");
    assert.ok(!html.match(/a2[^"]*data-started/s), "completed agent should NOT have data-started");
  });

  it("renders agent rows in a table", () => {
    const status = makeStatus({
      agents: {
        "agent-1": { type: "coder", status: "running", prompt: "Implement feature X" },
        "agent-2": { type: "reviewer", status: "completed", prompt: "Review PR #42" },
      },
    });
    renderDashboard(workdir, status);
    const html = readFileSync(join(workdir, "dashboard.html"), "utf-8");

    assert.ok(html.includes("agent-1"));
    assert.ok(html.includes("agent-2"));
    assert.ok(html.includes("coder"));
    assert.ok(html.includes("reviewer"));
    assert.ok(html.includes("Implement feature X"));
    assert.ok(html.includes("Review PR #42"));
  });

  it("shows 'No agents yet' when agents map is empty", () => {
    renderDashboard(workdir, makeStatus({ agents: {} }));
    const html = readFileSync(join(workdir, "dashboard.html"), "utf-8");
    assert.ok(html.includes("No agents yet"));
  });

  it("applies correct status colors", () => {
    const status = makeStatus({
      agents: {
        a: { status: "running" },
        b: { status: "completed" },
        c: { status: "failed" },
        d: { status: "timed_out" },
        e: { status: "stopped" },
        f: { status: "queued" },
      },
    });
    renderDashboard(workdir, status);
    const html = readFileSync(join(workdir, "dashboard.html"), "utf-8");

    assert.ok(html.includes("#3b82f6")); // running
    assert.ok(html.includes("#22c55e")); // completed
    assert.ok(html.includes("#ef4444")); // failed
    assert.ok(html.includes("#f59e0b")); // timed_out
    assert.ok(html.includes("#6b7280")); // stopped
    assert.ok(html.includes("#a855f7")); // queued
  });

  it("truncates prompt to 80 characters", () => {
    const longPrompt = "A".repeat(120);
    const status = makeStatus({
      agents: {
        a: { status: "running", prompt: longPrompt },
      },
    });
    renderDashboard(workdir, status);
    const html = readFileSync(join(workdir, "dashboard.html"), "utf-8");

    // Should contain truncated version (80 chars + ellipsis)
    assert.ok(html.includes("A".repeat(80) + "…"));
    // Should NOT contain the full 120-char string
    assert.ok(!html.includes("A".repeat(120)));
  });

  it("displays workflow state and phase info", () => {
    const status = makeStatus({ state: "running", phase: 2, totalPhases: 5 });
    renderDashboard(workdir, status);
    const html = readFileSync(join(workdir, "dashboard.html"), "utf-8");

    assert.ok(html.includes("2"));    // phase
    assert.ok(html.includes("5"));    // totalPhases
    // Workflow state color for "running" = #22c55e
    assert.ok(html.includes("#22c55e"));
  });
});

describe("esc", () => {
  it("escapes single quotes as &#x27;", () => {
    assert.equal(esc("it's \"fine\""), "it&#x27;s &quot;fine&quot;");
  });

  it("escapes backticks", () => {
    assert.equal(esc("abc`def"), "abc&#96;def");
  });

  it("escapes all HTML special chars together", () => {
    assert.equal(esc("<a href='x'>"), "&lt;a href=&#x27;x&#x27;&gt;");
  });
});

describe("truncate", () => {
  it("does not split surrogate pairs", () => {
    // 😀 is U+1F600 = \uD83D\uDE00 (surrogate pair, 2 code units)
    const result = truncate("a😀b", 2);
    // slice(0,2) would be "a\uD83D" (broken high surrogate)
    // should either drop the half-surrogate or keep the full pair
    const hasBrokenSurrogate = /\uD83D(?![\uDC00-\uDFFF])/.test(result);
    assert.equal(hasBrokenSurrogate, false, "should not end with lone high surrogate");
  });
});
