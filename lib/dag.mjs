export function createDAG(nodes) {
  const map = new Map()
  const ids = []

  for (const node of nodes) {
    if (map.has(node.id)) throw new Error(`duplicate node id: ${node.id}`)
    map.set(node.id, { ...node })
    ids.push(node.id)
  }

  for (const node of nodes) {
    for (const dep of node.deps) {
      if (!map.has(dep)) throw new Error(`unknown dep "${dep}" referenced by node "${node.id}"`)
    }
  }

  return { nodes: map, ids }
}

export function topoSort(dag) {
  const inDeg = new Map()
  for (const id of dag.ids) inDeg.set(id, 0)
  for (const id of dag.ids) {
    for (const dep of dag.nodes.get(id).deps) {
      inDeg.set(id, inDeg.get(id) + 1)
    }
  }

  const queue = dag.ids.filter((id) => inDeg.get(id) === 0)
  let qi = 0
  const result = []

  while (qi < queue.length) {
    const id = queue[qi++]
    result.push(id)
    for (const candidate of dag.ids) {
      const node = dag.nodes.get(candidate)
      if (node.deps.includes(id)) {
        inDeg.set(candidate, inDeg.get(candidate) - 1)
        if (inDeg.get(candidate) === 0) queue.push(candidate)
      }
    }
  }

  if (result.length !== dag.ids.length) {
    throw new Error(`cycle detected: sorted ${result.length}/${dag.ids.length} nodes`)
  }

  return result
}

export function detectCycles(dag) {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map()
  for (const id of dag.ids) color.set(id, WHITE)

  const cycles = []

  function dfs(id, path) {
    color.set(id, GRAY)
    path.push(id)

    for (const dep of dag.nodes.get(id).deps) {
      if (color.get(dep) === GRAY) {
        const start = path.indexOf(dep)
        cycles.push(path.slice(start))
      } else if (color.get(dep) === WHITE) {
        dfs(dep, path)
      }
    }

    path.pop()
    color.set(id, BLACK)
  }

  for (const id of dag.ids) {
    if (color.get(id) === WHITE) dfs(id, [])
  }

  return cycles
}

export function layers(dag) {
  const completed = new Set()
  const remaining = new Set(dag.ids)
  const result = []

  while (remaining.size > 0) {
    const layer = []
    for (const id of remaining) {
      const deps = dag.nodes.get(id).deps
      if (deps.every((d) => completed.has(d))) layer.push(id)
    }

    if (layer.length === 0) {
      throw new Error(`cycle detected: ${[...remaining].join(", ")} have unresolvable deps`)
    }

    for (const id of layer) {
      completed.add(id)
      remaining.delete(id)
    }
    result.push(layer)
  }

  return result
}

export function readyNodes(dag, completed = []) {
  const done = new Set(completed)
  const result = []

  for (const id of dag.ids) {
    if (done.has(id)) continue
    const deps = dag.nodes.get(id).deps
    if (deps.every((d) => done.has(d))) result.push(id)
  }

  return result
}

export function getNode(dag, id) {
  return dag.nodes.get(id)
}
