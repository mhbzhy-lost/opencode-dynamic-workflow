import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { renderDashboard } from "./dashboard.mjs";

export function readCommand(commandsDir, type, id) {
  const filePath = join(commandsDir, `${type}_${id}.json`);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`malformed JSON in command file ${filePath}: ${e.message}`);
  }
}

export async function waitForCommand(commandsDir, type, id, { pollInterval = 200, timeout = 60000 } = {}) {
  const start = Date.now();
  while (true) {
    const result = readCommand(commandsDir, type, id);
    if (result !== null) return result;
    if (Date.now() - start >= timeout) {
      throw new Error(`timeout waiting for command ${type}_${id} after ${timeout}ms`);
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
}

/**
 * Ensure the project .gitignore contains /.workflow/.
 * .gitignore lives in resolve(workdir, '..').
 */
function ensureGitignore(workdir) {
  const gitignorePath = join(resolve(workdir, ".."), ".gitignore");
  let content = "";
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, "utf-8");
    if (/\.workflow/m.test(content)) return; // already present
  }
  const entry = "/.workflow/\n";
  const newContent = content ? (content.endsWith("\n") ? content + entry : content + "\n" + entry) : entry;
  writeFileSync(gitignorePath, newContent);
}

function defaultStatus() {
  return {
    state: "running",
    phase: 1,
    totalPhases: null,
    startedAt: new Date().toISOString(),
    agents: {},
  };
}

function readStatusFile(workdir) {
  const p = join(workdir, "status.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function writeStatusFile(workdir, status) {
  writeFileSync(join(workdir, "status.json"), JSON.stringify(status, null, 2));
}

export function createIpc(workdir) {
  // Initialise directory structure
  mkdirSync(join(workdir, "events"), { recursive: true });
  mkdirSync(join(workdir, "commands"), { recursive: true });
  ensureGitignore(workdir);

  // Track event sequence number
  let eventSeq = 0;

  // Track phase (each parallel batch / standalone agent = 1 phase)
  let phaseCount = 0;

  return {
    updateAgentStatus(agentId, agentInfo) {
      const status = readStatusFile(workdir) || defaultStatus();
      status.agents[agentId] = { ...(status.agents[agentId] || {}), ...agentInfo };
      writeStatusFile(workdir, status);
      renderDashboard(workdir, status);
    },

    updateState(newState) {
      const status = readStatusFile(workdir) || defaultStatus();
      status.state = newState;
      writeStatusFile(workdir, status);
      renderDashboard(workdir, status);
    },

    emitEvent(eventData) {
      eventSeq += 1;
      const filename = String(eventSeq).padStart(3, "0") + ".json";
      const data = { ...eventData, timestamp: new Date().toISOString() };
      writeFileSync(join(workdir, "events", filename), JSON.stringify(data, null, 2));
      return eventSeq;
    },

    consumeCommands() {
      const dir = join(workdir, "commands");
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort();
      const commands = [];
      for (const f of files) {
        const fp = join(dir, f);
        commands.push(JSON.parse(readFileSync(fp, "utf-8")));
        unlinkSync(fp);
      }
      return commands;
    },

    writePid(pid) {
      writeFileSync(join(workdir, "pid"), String(pid));
    },

    readPid() {
      const p = join(workdir, "pid");
      if (!existsSync(p)) return null;
      return Number(readFileSync(p, "utf-8").trim());
    },

    writeSnapshot(snapshot) {
      writeFileSync(join(workdir, "snapshot.json"), JSON.stringify(snapshot, null, 2));
    },

    readSnapshot() {
      const p = join(workdir, "snapshot.json");
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, "utf-8"));
    },

    writeResult(result) {
      writeFileSync(join(workdir, "result.json"), JSON.stringify(result, null, 2));
    },

    readStatus() {
      return readStatusFile(workdir);
    },

    advancePhase(totalPhases) {
      phaseCount += 1;
      const status = readStatusFile(workdir) || defaultStatus();
      status.phase = phaseCount;
      if (totalPhases != null && status.totalPhases == null) status.totalPhases = totalPhases;
      writeStatusFile(workdir, status);
      renderDashboard(workdir, status);
    },
  };
}
