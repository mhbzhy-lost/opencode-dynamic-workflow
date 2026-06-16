export const EVENTS = {
  NEED_AGENT: "need_agent",
  PROGRESS: "progress",
  PHASE_START: "phase_start",
  PHASE_END: "phase_end",
  COMPLETED: "completed",
};

export function emitEvent(type, payload) {
  process.stdout.write(`[workflow:${type}] ${JSON.stringify(payload)}\n`);
}
