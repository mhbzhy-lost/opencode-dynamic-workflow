import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { promote } from "../lib/promote.mjs"

describe("T5.2: Promote Decision", () => {
  it("inherit: ref=1 means last dependent", async () => {
    const completedAtoms = new Map([
      ["A", { ref: 1, path: "/tmp/a" }]
    ])
    
    const deps = ["A"]
    const result = await promote("B", deps, completedAtoms)
    
    assert.equal(result.action, "inherit", "should inherit (ref: 1->0)")
    assert.equal(result.primaryAtom, "A")
    assert.equal(completedAtoms.get("A").ref, 0)
    assert.deepEqual(result.toMerge, [])
    assert.deepEqual(result.toRecycle, [])
  })

  it("inherit: single dependent with ref>1", async () => {
    const completedAtoms = new Map([
      ["A", { ref: 2, path: "/tmp/a" }]
    ])
    
    const deps = ["A"]
    const result = await promote("B", deps, completedAtoms)
    
    assert.equal(result.action, "inherit", "should inherit (ref: 2->1)")
    assert.equal(result.primaryAtom, "A")
    assert.equal(completedAtoms.get("A").ref, 1)
    assert.deepEqual(result.toMerge, [])
    assert.deepEqual(result.toRecycle, [])
  })

  it("fork: no remaining refs", async () => {
    const completedAtoms = new Map([
      ["A", { ref: 0, path: "/tmp/a" }]
    ])
    
    const deps = ["A"]
    const result = await promote("B", deps, completedAtoms)
    
    assert.equal(result.action, "fork", "should fork (no remaining refs)")
    assert.equal(result.primaryAtom, "A")
    assert.deepEqual(result.toMerge, [])
    assert.deepEqual(result.toRecycle, [])
  })

  it("acquire: merge multiple dependencies", async () => {
    const completedAtoms = new Map([
      ["A", { ref: 1, path: "/tmp/a" }],
      ["B", { ref: 1, path: "/tmp/b" }]
    ])
    
    const deps = ["A", "B"]
    const result = await promote("C", deps, completedAtoms)
    
    assert.equal(result.action, "acquire")
    assert.equal(result.primaryAtom, "A")
    assert.deepEqual(result.toMerge, ["B"])
    assert.deepEqual(result.toRecycle, [])
  })

  it("handles diamond with mixed refs", async () => {
    const completedAtoms = new Map([
      ["B", { ref: 1, path: "/tmp/b" }],
      ["C", { ref: 1, path: "/tmp/c" }]
    ])
    
    const deps = ["B", "C"]
    const result = await promote("D", deps, completedAtoms)
    
    assert.equal(result.action, "acquire")
    assert.equal(result.primaryAtom, "B")
    assert.deepEqual(result.toMerge, ["C"])
  })

  it("identifies atoms for recycling after merge", async () => {
    const completedAtoms = new Map([
      ["A", { ref: 0, path: "/tmp/a" }],  // ref=0 表示已经被所有依赖者使用
      ["B", { ref: 1, path: "/tmp/b" }]
    ])
    
    const deps = ["A", "B"]
    const result = await promote("C", deps, completedAtoms)
    
    assert.equal(result.action, "acquire")
    assert.equal(result.primaryAtom, "B")
    assert.deepEqual(result.toMerge, ["A"])
    assert.deepEqual(result.toRecycle, ["A"])
  })
})
