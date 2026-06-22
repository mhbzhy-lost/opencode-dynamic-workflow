export const EVENTS = {
  NEED_AGENT: "need_agent",
  PROGRESS: "progress",
  PHASE_START: "phase_start",
  PHASE_END: "phase_end",
  COMPLETED: "completed",
  TASK_READY: "task_ready",
  TASK_PROMOTED: "task_promoted",
  ATOM_RECYCLED: "atom_recycled",
  ATOM_REUSED: "atom_reused",
};

export function emitEvent(type, payload) {
  process.stdout.write(`[workflow:${type}] ${JSON.stringify(payload)}\n`);
}
