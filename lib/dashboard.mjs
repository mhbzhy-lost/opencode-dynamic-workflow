import { writeFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_STATUS_COLORS = {
  running: "#3b82f6",
  completed: "#22c55e",
  failed: "#ef4444",
  timed_out: "#f59e0b",
  stopped: "#6b7280",
  queued: "#a855f7",
};

const WORKFLOW_STATE_COLORS = {
  running: "#22c55e",
  paused: "#f59e0b",
  completed: "#3b82f6",
  aborted: "#ef4444",
};

export function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/`/g, "&#96;");
}

export function truncate(str, max) {
  if (str == null) return "";
  const s = String(str);
  if (s.length <= max) return s;
  let sliced = s.slice(0, max);
  const lastCode = sliced.charCodeAt(sliced.length - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
    sliced = sliced.slice(0, -1);
  }
  return sliced + "\u2026";
}

function formatDuration(agent) {
  // Use pre-calculated durationMs when available (completed/failed agents)
  if (agent.durationMs != null) {
    const sec = Math.round(agent.durationMs / 1000);
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
  }
  // Fall back to live calculation for running agents
  if (!agent.startedAt) return "-";
  const start = new Date(agent.startedAt).getTime();
  const sec = Math.round((Date.now() - start) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
}

function durationAttrs(agent) {
  // Provide data-started attribute for running agents so JS can update in real-time
  if (agent.status === "running" && agent.startedAt) {
    return ` data-started="${esc(agent.startedAt)}"`;
  }
  return "";
}

function agentRows(agents) {
  const ids = Object.keys(agents);
  if (ids.length === 0) {
    return `<tr><td colspan="6" style="text-align:center;color:#94a3b8">No agents yet</td></tr>`;
  }
  return ids
    .map((id) => {
      const a = agents[id];
      const color = AGENT_STATUS_COLORS[a.status] || "#94a3b8";
      return `<tr>
<td>${esc(id)}</td>
<td>${esc(a.type || "-")}</td>
<td style="color:${color};font-weight:600">${esc(a.status || "-")}</td>
<td${durationAttrs(a)}>${formatDuration(a)}</td>
<td>${esc(truncate(a.prompt, 80))}</td>
<td>${esc(truncate(a.output || a.error, 80))}</td>
</tr>`;
    })
    .join("\n");
}

export function renderDashboard(workdir, status) {
  const stateColor = WORKFLOW_STATE_COLORS[status.state] || "#94a3b8";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="3">
<title>Workflow Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;color:#e2e8f0;font-family:ui-monospace,monospace;padding:24px}
h1{font-size:1.4rem;margin-bottom:16px}
.meta{margin-bottom:20px;display:flex;gap:24px;align-items:center}
.meta span{font-size:.95rem}
table{width:100%;border-collapse:collapse;margin-top:12px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #1e293b}
th{color:#94a3b8;font-weight:500;font-size:.85rem;text-transform:uppercase}
tr:hover{background:#1e293b}
</style>
</head>
<body>
<h1>Workflow Dashboard</h1>
<div class="meta">
<span>State: <strong style="color:${stateColor}">${esc(status.state)}</strong></span>
<span>Phase: ${status.phase}${status.totalPhases ? "/" + status.totalPhases : ""}</span>
<span>Started: ${esc(status.startedAt)}</span>
</div>
<table>
<thead><tr><th>Agent</th><th>Type</th><th>Status</th><th>Duration</th><th>Prompt</th><th>Result / Error</th></tr></thead>
<tbody>
${agentRows(status.agents || {})}
</tbody>
</table>
<script>
(function() {
  function fmt(ms) {
    var sec = Math.round(ms / 1000);
    return sec < 60 ? sec + "s" : Math.floor(sec / 60) + "m" + (sec % 60) + "s";
  }
  function tick() {
    var cells = document.querySelectorAll("td[data-started]");
    var now = Date.now();
    for (var i = 0; i < cells.length; i++) {
      var t = new Date(cells[i].getAttribute("data-started")).getTime();
      if (!isNaN(t)) cells[i].textContent = fmt(now - t);
    }
  }
  tick();
  setInterval(tick, 1000);
})();
</script>
</body>
</html>`;

  writeFileSync(join(workdir, "dashboard.html"), html);
}
