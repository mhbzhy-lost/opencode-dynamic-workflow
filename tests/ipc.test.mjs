import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createIpc } from "../lib/ipc.mjs";

/**
 * Helper: create a temp project root with a .workflow/ subdirectory.
 * projectRoot/
 *   .workflow/     ← workdir passed to createIpc
 */
function makeTempProject() {
  const projectRoot = mkdtempSync(join(tmpdir(), "ipc-test-"));
  const workdir = join(projectRoot, ".workflow");
  mkdirSync(workdir, { recursive: true });
  return { projectRoot, workdir };
}

describe("createIpc", () => {
  let projectRoot, workdir, ipc;

  beforeEach(() => {
    ({ projectRoot, workdir } = makeTempProject());
    ipc = createIpc(workdir);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // ── directory structure ──────────────────────────────────────────────
  it("creates events/ and commands/ directories", () => {
    assert.ok(existsSync(join(workdir, "events")));
    assert.ok(existsSync(join(workdir, "commands")));
  });

  // ── ensureGitignore ──────────────────────────────────────────────────
  it("creates .gitignore with /.workflow/ when none exists", () => {
    const gi = join(projectRoot, ".gitignore");
    const content = readFileSync(gi, "utf-8");
    assert.ok(content.includes("/.workflow/"));
  });

  it("appends /.workflow/ to existing .gitignore that lacks it", () => {
    // Clean up the one created by createIpc, write a custom one, re-init
    rmSync(projectRoot, { recursive: true, force: true });
    ({ projectRoot, workdir } = makeTempProject());
    writeFileSync(join(projectRoot, ".gitignore"), "node_modules/\n");
    ipc = createIpc(workdir);

    const content = readFileSync(join(projectRoot, ".gitignore"), "utf-8");
    assert.ok(content.includes("node_modules/"));
    assert.ok(content.includes("/.workflow/"));
  });

  it("skips appending when .gitignore already contains .workflow", () => {
    rmSync(projectRoot, { recursive: true, force: true });
    ({ projectRoot, workdir } = makeTempProject());
    writeFileSync(join(projectRoot, ".gitignore"), "node_modules/\n/.workflow/\n");
    ipc = createIpc(workdir);

    const content = readFileSync(join(projectRoot, ".gitignore"), "utf-8");
    // Should appear exactly once
    const matches = content.match(/\.workflow/g);
    assert.equal(matches.length, 1);
  });

  // ── updateAgentStatus ────────────────────────────────────────────────
  it("updateAgentStatus creates status.json and dashboard.html on first call", () => {
    ipc.updateAgentStatus("agent-1", { type: "coder", status: "running" });

    assert.ok(existsSync(join(workdir, "status.json")));
    assert.ok(existsSync(join(workdir, "dashboard.html")));

    const status = JSON.parse(readFileSync(join(workdir, "status.json"), "utf-8"));
    assert.equal(status.agents["agent-1"].type, "coder");
    assert.equal(status.agents["agent-1"].status, "running");
    assert.equal(status.state, "running");
  });

  it("updateAgentStatus merges agent info instead of overwriting", () => {
    ipc.updateAgentStatus("agent-1", { type: "coder", status: "running" });
    ipc.updateAgentStatus("agent-1", { status: "completed", result: "ok" });

    const status = JSON.parse(readFileSync(join(workdir, "status.json"), "utf-8"));
    assert.equal(status.agents["agent-1"].type, "coder");       // preserved
    assert.equal(status.agents["agent-1"].status, "completed");  // updated
    assert.equal(status.agents["agent-1"].result, "ok");         // added
  });

  // ── updateState ──────────────────────────────────────────────────────
  it("updateState changes the state field", () => {
    ipc.updateAgentStatus("a", { status: "running" }); // seed status.json
    ipc.updateState("paused");

    const status = JSON.parse(readFileSync(join(workdir, "status.json"), "utf-8"));
    assert.equal(status.state, "paused");
    assert.ok(existsSync(join(workdir, "dashboard.html")));
  });

  // ── emitEvent ────────────────────────────────────────────────────────
  it("emitEvent writes sequentially numbered event files", () => {
    const seq1 = ipc.emitEvent({ type: "started" });
    const seq2 = ipc.emitEvent({ type: "progress", pct: 50 });

    assert.equal(seq1, 1);
    assert.equal(seq2, 2);

    const ev1 = JSON.parse(readFileSync(join(workdir, "events", "001.json"), "utf-8"));
    assert.equal(ev1.type, "started");
    assert.ok(ev1.timestamp);

    const ev2 = JSON.parse(readFileSync(join(workdir, "events", "002.json"), "utf-8"));
    assert.equal(ev2.type, "progress");
    assert.equal(ev2.pct, 50);
  });

  // ── consumeCommands ──────────────────────────────────────────────────
  it("consumeCommands reads, sorts and deletes command files", () => {
    writeFileSync(join(workdir, "commands", "002.json"), JSON.stringify({ action: "stop" }));
    writeFileSync(join(workdir, "commands", "001.json"), JSON.stringify({ action: "pause" }));

    const cmds = ipc.consumeCommands();
    assert.equal(cmds.length, 2);
    assert.equal(cmds[0].action, "pause");  // 001 first
    assert.equal(cmds[1].action, "stop");   // 002 second

    // Files deleted
    assert.equal(readdirSync(join(workdir, "commands")).length, 0);
  });

  it("consumeCommands returns empty array for empty directory", () => {
    const cmds = ipc.consumeCommands();
    assert.deepEqual(cmds, []);
  });

  // ── pid ──────────────────────────────────────────────────────────────
  it("writePid / readPid round-trip", () => {
    ipc.writePid(12345);
    assert.equal(ipc.readPid(), 12345);
  });

  it("readPid returns null when no pid file", () => {
    assert.equal(ipc.readPid(), null);
  });

  // ── snapshot ─────────────────────────────────────────────────────────
  it("writeSnapshot / readSnapshot round-trip", () => {
    const snap = { phase: 2, agents: ["a", "b"] };
    ipc.writeSnapshot(snap);
    assert.deepEqual(ipc.readSnapshot(), snap);
  });

  it("readSnapshot returns null when no file", () => {
    assert.equal(ipc.readSnapshot(), null);
  });

  // ── result ───────────────────────────────────────────────────────────
  it("writeResult writes result.json", () => {
    ipc.writeResult({ ok: true, summary: "done" });
    const data = JSON.parse(readFileSync(join(workdir, "result.json"), "utf-8"));
    assert.deepEqual(data, { ok: true, summary: "done" });
  });

  // ── readStatus ───────────────────────────────────────────────────────
  it("readStatus returns null when no status.json", () => {
    assert.equal(ipc.readStatus(), null);
  });

  it("readStatus returns status after updateAgentStatus", () => {
    ipc.updateAgentStatus("x", { status: "queued" });
    const s = ipc.readStatus();
    assert.equal(s.state, "running");
    assert.equal(s.agents.x.status, "queued");
  });
});
