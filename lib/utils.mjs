/**
 * countRefs - Count incoming edges for each node in the DAG
 * @param {Object} dag - DAG object { nodes: Map, ids: Array }
 * @returns {Map<string, number>} Map node id to ref count
 */
export function countRefs(dag) {
  const refs = new Map(dag.ids.map(id => [id, 0]))
  for (const id of dag.ids) {
    const node = dag.nodes.get(id)
    for (const dep of node.deps) {
      refs.set(dep, refs.get(dep) + 1)
    }
  }
  return refs
}
