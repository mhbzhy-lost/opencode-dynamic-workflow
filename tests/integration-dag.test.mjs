/**
 * T5.2: Integration Test - DAG Ref Counting and Promotion
 *
 * 验证 DAG 场景下的引用计数计算和晋升决策
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createDAG, dependents, isReady } from "../lib/dag.mjs"
import { countRefs } from "../lib/utils.mjs"
import { PromotionCoordinator } from "../lib/promote.mjs"

describe("T5.2: Integration Test - DAG with Promotion", () => {
  it("diamond DAG ref counting is correct", () => {
    // A -> B, A -> C, B -> D, C -> D
    const dag = createDAG([
      { id: "A", deps: [], prompt: "create A.txt" },
      { id: "B", deps: ["A"], prompt: "append B" },
      { id: "C", deps: ["A"], prompt: "append C" },
      { id: "D", deps: ["B", "C"], prompt: "append D" }
    ])

    const refs = countRefs(dag)
    assert.equal(refs.get("A"), 2)
    assert.equal(refs.get("B"), 1)
    assert.equal(refs.get("C"), 1)
    assert.equal(refs.get("D"), 0)
    
    // Verify dependents
    assert.deepEqual(dependents(dag, "A").sort(), ["B", "C"])
    assert.deepEqual(dependents(dag, "B"), ["D"])
    assert.deepEqual(dependents(dag, "C"), ["D"])
    assert.deepEqual(dependents(dag, "D"), [])
  })

  it("promotion coordinator processes diamond DAG correctly", () => {
    const dag = createDAG([
      { id: "A", deps: [], prompt: "create A" },
      { id: "B", deps: ["A"], prompt: "append B" },
      { id: "C", deps: ["A"], prompt: "append C" },
      { id: "D", deps: ["B", "C"], prompt: "append D" }
    ])

    const refs = countRefs(dag)
    const completed = new Map([["A", { ref: refs.get("A") }]])
    const coordinator = new PromotionCoordinator(completed)
    
    // B depends on A, and A has ref=2 (used by B and C)
    const decB = coordinator.promote("B", ["A"], completed)
    assert.equal(decB.action, "inherit")  // ref: 2->1, inherit because ref was > 0
    assert.equal(completed.get("A").ref, 1)
    
    completed.set("B", { ref: refs.get("B") })
    assert.equal(isReady(dag, "D", [...completed.keys()]), false)
    
    // C depends on A, and A now has ref=1 (only used by C)
    const decC = coordinator.promote("C", ["A"], completed)
    assert.equal(decC.action, "inherit")  // A only used by C now, so inherit
    assert.equal(completed.get("A").ref, 0)
    
    completed.set("C", { ref: refs.get("C") })
    assert.equal(isReady(dag, "D", [...completed.keys()]), true)
    
    // D depends on B and C
    const decD = coordinator.promote("D", ["B", "C"], completed)
    assert.equal(decD.action, "acquire")
    assert.equal(decD.toMerge.length, 1)
  })
})
