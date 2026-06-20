import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { countRefs } from "../lib/utils.mjs"
import { createDAG } from "../lib/dag.mjs"
import { PromotionCoordinator } from "../lib/promote.mjs"

describe("T5.1: Ref Count Calculation", () => {
  it("calculates refs for simple chain A->B->C", () => {
    const dag = createDAG([
      { id: "A", deps: [], prompt: "" },
      { id: "B", deps: ["A"], prompt: "" },
      { id: "C", deps: ["B"], prompt: "" },
    ])

    const refs = countRefs(dag)

    assert.equal(refs.get("A"), 1, "A should have 1 dependent (B)")
    assert.equal(refs.get("B"), 1, "B should have 1 dependent (C)")
    assert.equal(refs.get("C"), 0, "C is last, no dependents")
  })

  it("calculates refs for diamond pattern A->B,C->D", () => {
    const dag = createDAG([
      { id: "A", deps: [], prompt: "" },
      { id: "B", deps: ["A"], prompt: "" },
      { id: "C", deps: ["A"], prompt: "" },
      { id: "D", deps: ["B", "C"], prompt: "" },
    ])

    const refs = countRefs(dag)

    assert.equal(refs.get("A"), 2, "A has 2 dependents (B and C)")
    assert.equal(refs.get("B"), 1, "B has 1 dependent (D)")
    assert.equal(refs.get("C"), 1, "C has 1 dependent (D)")
    assert.equal(refs.get("D"), 0, "D is last")
  })

  it("handles multiple independent chains", () => {
    const dag = createDAG([
      { id: "A", deps: [], prompt: "" },
      { id: "B", deps: ["A"], prompt: "" },
      { id: "X", deps: [], prompt: "" },
      { id: "Y", deps: ["X"], prompt: "" },
      { id: "Z", deps: ["Y"], prompt: "" },
    ])

    const refs = countRefs(dag)

    assert.equal(refs.get("A"), 1)
    assert.equal(refs.get("B"), 0)
    assert.equal(refs.get("X"), 1)
    assert.equal(refs.get("Y"), 1)
    assert.equal(refs.get("Z"), 0)
  })

  it("handles complex graph with multiple roots", () => {
    const dag = createDAG([
      { id: "A", deps: [], prompt: "" },
      { id: "B", deps: [], prompt: "" },
      { id: "C", deps: ["A"], prompt: "" },
      { id: "D", deps: ["A", "B"], prompt: "" },
      { id: "E", deps: ["C", "D"], prompt: "" },
    ])

    const refs = countRefs(dag)

    assert.equal(refs.get("A"), 2, "A is depended on by C and D")
    assert.equal(refs.get("B"), 1, "B is depended on by D")
    assert.equal(refs.get("C"), 1, "C is depended on by E")
    assert.equal(refs.get("D"), 1, "D is depended on by E")
    assert.equal(refs.get("E"), 0, "E has no dependents")
  })

  it("PromotionCoordinator accepts refs from utils.countRefs", () => {
    const dag = createDAG([
      { id: "A", deps: [], prompt: "x" },
      { id: "B", deps: ["A"], prompt: "y" },
    ])
    const refs = countRefs(dag)

    const coordinator = new PromotionCoordinator(refs)
    assert.ok(coordinator)
  })
})
