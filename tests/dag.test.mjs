import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { createDAG, topoSort, detectCycles, layers, readyNodes, getNode, dependents, isReady } from "../lib/dag.mjs"

// ---------------------------------------------------------------------------
// createDAG
// ---------------------------------------------------------------------------
describe("createDAG", () => {
  it("creates a DAG object from valid nodes", () => {
    const dag = createDAG([
      { id: "a", deps: [] },
      { id: "b", deps: ["a"] },
    ])

    assert.ok(dag)
    assert.equal(dag.nodes.size, 2)
    assert.deepEqual([...dag.ids], ["a", "b"])
  })

  it("throws when a dep references an unknown node", () => {
    assert.throws(
      () => createDAG([{ id: "a", deps: ["missing"] }]),
      /unknown dep.*missing/i,
    )
  })

  it("throws on duplicate ids", () => {
    assert.throws(
      () => createDAG([{ id: "a", deps: [] }, { id: "a", deps: [] }]),
      /duplicate.*a/i,
    )
  })
})

// ---------------------------------------------------------------------------
// topoSort
// ---------------------------------------------------------------------------
describe("topoSort", () => {
  it("returns correct order for a simple chain", () => {
    const dag = createDAG([
      { id: "a", deps: [] },
      { id: "b", deps: ["a"] },
      { id: "c", deps: ["b"] },
    ])

    assert.deepEqual(topoSort(dag), ["a", "b", "c"])
  })

  it("returns correct order for the example DAG", () => {
    const dag = createDAG([
      { id: "research", deps: [] },
      { id: "design", deps: ["research"] },
      { id: "impl-A", deps: ["design"] },
      { id: "impl-B", deps: ["design"] },
      { id: "integrate", deps: ["impl-A", "impl-B"] },
    ])

    const sorted = topoSort(dag)
    assert.equal(sorted.length, 5)
    assert.ok(sorted.indexOf("research") < sorted.indexOf("design"))
    assert.ok(sorted.indexOf("design") < sorted.indexOf("impl-A"))
    assert.ok(sorted.indexOf("design") < sorted.indexOf("impl-B"))
    assert.ok(sorted.indexOf("impl-A") < sorted.indexOf("integrate"))
    assert.ok(sorted.indexOf("impl-B") < sorted.indexOf("integrate"))
  })

  it("throws on cycle A→B→A", () => {
    assert.throws(
      () => topoSort(createDAG([
        { id: "a", deps: ["b"] },
        { id: "b", deps: ["a"] },
      ])),
      /cycle/i,
    )
  })

  it("correctly sorts a 200-node linear chain", () => {
    const nodes = []
    for (let i = 0; i < 200; i++) {
      nodes.push({ id: `n${i}`, deps: i === 0 ? [] : [`n${i - 1}`] })
    }
    const dag = createDAG(nodes)
    const sorted = topoSort(dag)
    assert.equal(sorted.length, 200)
    for (let i = 0; i < 200; i++) {
      assert.equal(sorted[i], `n${i}`)
    }
  })
})

// ---------------------------------------------------------------------------
// detectCycles
// ---------------------------------------------------------------------------
describe("detectCycles", () => {
  it("returns empty array for acyclic graph", () => {
    const dag = createDAG([
      { id: "a", deps: [] },
      { id: "b", deps: ["a"] },
    ])

    assert.deepEqual(detectCycles(dag), [])
  })

  it("returns cycle path for A→B→C→A", () => {
    const dag = createDAG([
      { id: "a", deps: ["c"] },
      { id: "b", deps: ["a"] },
      { id: "c", deps: ["b"] },
    ])

    const cycles = detectCycles(dag)
    assert.ok(cycles.length > 0)
    const cycle = cycles[0]
    assert.equal(cycle.length, 3)
    assert.ok(cycle.includes("a"))
    assert.ok(cycle.includes("b"))
    assert.ok(cycle.includes("c"))
  })

  it("returns multiple independent cycles", () => {
    const dag = createDAG([
      { id: "a", deps: ["b"] },
      { id: "b", deps: ["a"] },
      { id: "c", deps: ["d"] },
      { id: "d", deps: ["c"] },
    ])

    const cycles = detectCycles(dag)
    assert.ok(cycles.length >= 2, `expected >=2 cycles, got ${cycles.length}`)
  })
})

// ---------------------------------------------------------------------------
// layers
// ---------------------------------------------------------------------------
describe("layers", () => {
  it("groups independent nodes at the same layer", () => {
    const dag = createDAG([
      { id: "a", deps: [] },
      { id: "b", deps: [] },
      { id: "c", deps: ["a", "b"] },
    ])

    const ls = layers(dag)
    assert.deepEqual(ls, [["a", "b"], ["c"]])
  })

  it("handles diamond dependency A→B,C→D", () => {
    const dag = createDAG([
      { id: "a", deps: [] },
      { id: "b", deps: ["a"] },
      { id: "c", deps: ["a"] },
      { id: "d", deps: ["b", "c"] },
    ])

    const ls = layers(dag)
    assert.deepEqual(ls, [["a"], ["b", "c"], ["d"]])
  })

  it("returns the correct layers for the example DAG", () => {
    const dag = createDAG([
      { id: "research", deps: [] },
      { id: "design", deps: ["research"] },
      { id: "impl-A", deps: ["design"] },
      { id: "impl-B", deps: ["design"] },
      { id: "integrate", deps: ["impl-A", "impl-B"] },
    ])

    const ls = layers(dag)
    assert.deepEqual(ls, [["research"], ["design"], ["impl-A", "impl-B"], ["integrate"]])
  })
})

// ---------------------------------------------------------------------------
// readyNodes
// ---------------------------------------------------------------------------
describe("readyNodes", () => {
  const dag = () => createDAG([
    { id: "research", deps: [] },
    { id: "design", deps: ["research"] },
    { id: "impl-A", deps: ["design"] },
    { id: "impl-B", deps: ["design"] },
    { id: "integrate", deps: ["impl-A", "impl-B"] },
  ])

  it("returns root nodes when completed is empty", () => {
    assert.deepEqual(readyNodes(dag()), ["research"])
  })

  it("returns next tier when some nodes are completed", () => {
    const result = readyNodes(dag(), ["research", "design"])
    assert.deepEqual(result.sort(), ["impl-A", "impl-B"])
  })

  it("excludes already-completed nodes", () => {
    const result = readyNodes(dag(), ["research", "design", "impl-A"])
    assert.deepEqual(result, ["impl-B"])
  })

  it("returns empty when all nodes are completed", () => {
    const result = readyNodes(dag(), ["research", "design", "impl-A", "impl-B", "integrate"])
    assert.deepEqual(result, [])
  })
})

// ---------------------------------------------------------------------------
// getNode
// ---------------------------------------------------------------------------
describe("getNode", () => {
  it("returns the full node object with custom fields", () => {
    const dag = createDAG([
      { id: "a", deps: [], prompt: "do something", agent: "test" },
    ])

    const node = getNode(dag, "a")
    assert.equal(node.id, "a")
    assert.deepEqual(node.deps, [])
    assert.equal(node.prompt, "do something")
    assert.equal(node.agent, "test")
  })

  it("returns undefined for unknown id", () => {
    const dag = createDAG([{ id: "a", deps: [] }])
    assert.equal(getNode(dag, "missing"), undefined)
  })
})

// ---------------------------------------------------------------------------
// dependents
// ---------------------------------------------------------------------------
describe("dependents", () => {
  const dag = () => createDAG([
    { id: "a", deps: [] },
    { id: "b", deps: ["a"] },
    { id: "c", deps: ["a"] },
    { id: "d", deps: ["b", "c"] },
    { id: "e", deps: ["d"] },
  ])

  it("returns empty array for leaf node", () => {
    assert.deepEqual(dependents(dag(), "e"), [])
  })

  it("returns direct dependents for node with multiple dependents", () => {
    const result = dependents(dag(), "a")
    assert.deepEqual(result.sort(), ["b", "c"])
  })

  it("returns single dependent for intermediate node", () => {
    assert.deepEqual(dependents(dag(), "b"), ["d"])
    assert.deepEqual(dependents(dag(), "c"), ["d"])
  })

  it("returns empty array for unknown node", () => {
    assert.deepEqual(dependents(dag(), "missing"), [])
  })
})

// ---------------------------------------------------------------------------
// isReady
// ---------------------------------------------------------------------------
describe("isReady", () => {
  const dag = () => createDAG([
    { id: "a", deps: [] },
    { id: "b", deps: ["a"] },
    { id: "c", deps: ["a"] },
    { id: "d", deps: ["b", "c"] },
  ])

  it("returns true for root node with empty completed set", () => {
    assert.equal(isReady(dag(), "a", []), true)
  })

  it("returns false when dependencies not completed", () => {
    assert.equal(isReady(dag(), "b", []), false)
    assert.equal(isReady(dag(), "d", ["a"]), false)
    assert.equal(isReady(dag(), "d", ["a", "b"]), false)
  })

  it("returns true when all dependencies completed", () => {
    assert.equal(isReady(dag(), "b", ["a"]), true)
    assert.equal(isReady(dag(), "d", ["a", "b", "c"]), true)
  })

  it("returns false for already completed node", () => {
    assert.equal(isReady(dag(), "a", ["a"]), false)
    assert.equal(isReady(dag(), "b", ["a", "b"]), false)
  })

  it("returns false for unknown node", () => {
    assert.equal(isReady(dag(), "missing", []), false)
  })
})
