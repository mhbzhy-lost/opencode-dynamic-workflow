import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

import { EVENTS, emitEvent } from "../lib/events.mjs"

describe("EVENTS", () => {
  it("defines all required event types", () => {
    assert.equal(EVENTS.NEED_AGENT, "need_agent")
    assert.equal(EVENTS.PROGRESS, "progress")
    assert.equal(EVENTS.PHASE_START, "phase_start")
    assert.equal(EVENTS.PHASE_END, "phase_end")
    assert.equal(EVENTS.COMPLETED, "completed")
  })
})

describe("emitEvent", () => {
  let writes

  beforeEach(() => {
    writes = []
    const orig = process.stdout.write
    process.stdout.write = (chunk) => { writes.push(chunk) }
    emitEvent._restore = orig
  })

  afterEach(() => {
    process.stdout.write = emitEvent._restore
  })

  it("outputs [workflow:need_agent] with JSON payload to stdout", () => {
    emitEvent(EVENTS.NEED_AGENT, { id: "A" })
    assert.equal(writes.length, 1)
    assert.equal(writes[0], '[workflow:need_agent] {"id":"A"}\n')
  })

  it("outputs [workflow:progress] with phase and percent", () => {
    emitEvent(EVENTS.PROGRESS, { phase: 1, percent: 50 })
    assert.equal(writes[0], '[workflow:progress] {"phase":1,"percent":50}\n')
  })

  it("outputs correct prefix for phase_start", () => {
    emitEvent(EVENTS.PHASE_START, { phase: 2 })
    assert.equal(writes[0], '[workflow:phase_start] {"phase":2}\n')
  })

  it("outputs correct prefix for phase_end", () => {
    emitEvent(EVENTS.PHASE_END, { phase: 2 })
    assert.equal(writes[0], '[workflow:phase_end] {"phase":2}\n')
  })

  it("outputs correct prefix for completed", () => {
    emitEvent(EVENTS.COMPLETED, { ok: true })
    assert.equal(writes[0], '[workflow:completed] {"ok":true}\n')
  })
})
