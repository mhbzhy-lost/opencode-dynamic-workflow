/**
 * Promote — 晋升决策逻辑
 *
 * 三种晋升动作：
 * 1. inherit：直接继承 atom（单依赖、ref=1 时）
 * 2. fork：需要 fork atom（单依赖、ref>1 时）
 * 3. acquire：创建新 atom + merge 多个依赖（多依赖时）
 */

/**
 * PromotionCoordinator — 协调并发晋升决策
 * 
 * 维护原子 ref 计数，确保并发访问时 ref 递减的原子性
 */
export class PromotionCoordinator {
  /**
   * @param {Map|Object} initialRefs - 初始引用计数 { nodeId → count } 或 { nodeId → { ref: count } }
   */
  constructor(initialRefs) {
    // 兼容 Map 和普通对象
    if (initialRefs instanceof Map) {
      this.refs = Object.fromEntries(
        Array.from(initialRefs.entries()).map(([nodeId, value]) => [
          nodeId,
          typeof value === 'number' ? value : (value.ref ?? 0)
        ])
      )
    } else {
      this.refs = {}
      for (const [nodeId, value] of Object.entries(initialRefs)) {
        this.refs[nodeId] = typeof value === 'number' ? value : (value.ref ?? 0)
      }
    }
  }

  /**
   * 执行晋升决策（带原子性 ref 递减）
   * @param {string} taskId - 要晋升的任务 ID
   * @param {string[]} deps - 该任务的依赖列表
   * @param {Map} completedMap - 已完成任务映射 { depId → { result, atom } }
   * @returns {Object} 晋升决策结果
   */
  promote(taskId, deps, completedMap) {
    if (!Array.isArray(deps) || deps.length === 0) {
      throw new Error("promote requires non-empty deps array")
    }

    // 验证所有依赖都已完成
    for (const depId of deps) {
      if (!completedMap.has(depId)) {
        throw new Error(`dep ${depId} not completed`)
      }
    }

    // 单依赖情况
    if (deps.length === 1) {
      const depId = deps[0]
      const completedEntry = completedMap.get(depId)
      const refBefore = this.refs[depId] ?? 0

      if (refBefore > 0) {
        // inherit: ref > 0，直接继承并递减 ref
        this.refs[depId] = refBefore - 1
        if (completedEntry.ref !== undefined) {
          completedEntry.ref = refBefore - 1
        }
        
        return {
          action: "inherit",
          primaryAtom: depId,
          atom: completedEntry.atom,
          toMerge: [],
          toRecycle: []
        }
      } else {
        // fork: ref == 0，没有 slot，需要新创建
        return {
          action: "fork",
          primaryAtom: depId,
          atom: completedEntry.atom,
          toMerge: [],
          toRecycle: []
        }
      }
    }

    // 多依赖情况：acquire + merge
    // 选择 ref 最大的作为 primary（保留高 ref 的 atom 给其他依赖者，避免不必要的 recycle）
    let primaryDepId = null
    let maxRef = -1

    for (const depId of deps) {
      const ref = this.refs[depId] ?? 0
      if (ref > maxRef) {
        maxRef = ref
        primaryDepId = depId
      }
    }

    // 原子性地递减 primary 的 ref (both internal and in completedMap)
    const primaryEntry = completedMap.get(primaryDepId)
    const primaryRefBefore = this.refs[primaryDepId] ?? 0
    this.refs[primaryDepId] = Math.max(0, primaryRefBefore - 1)
    if (primaryEntry.ref !== undefined) {
      primaryEntry.ref = Math.max(0, primaryRefBefore - 1)
    }

    // 其余依赖需要 merge
    const toMerge = deps.filter(d => d !== primaryDepId).map(d => {
      const entry = completedMap.get(d)
      // 原子性地递减 ref (both internal and in completedMap)
      const refBefore = this.refs[d] ?? 0
      this.refs[d] = Math.max(0, refBefore - 1)
      if (entry.ref !== undefined) {
        entry.ref = Math.max(0, refBefore - 1)
      }
      return entry.atom
    })
    
    // ref=0 的 atom 应该被 recycle
    const toRecycle = toMerge.filter((atom, idx) => {
      const depId = deps.filter(d => d !== primaryDepId)[idx]
      const entry = completedMap.get(depId)
      return (entry.ref ?? 0) === 0
    })

    return {
      action: "acquire",
      primaryAtom: primaryDepId,
      atom: primaryEntry.atom,
      toMerge,
      toRecycle
    }
  }
}

/**
 * 执行晋升决策（纯函数，不递减 ref）
 * @param {string} taskId - 要晋升的任务 ID
 * @param {string[]} deps - 该任务的依赖列表
 * @param {Map} completedMap - 已完成任务映射 { depId → { ref, ... } }
 * @returns {Object} 晋升决策结果
 */
export function promote(taskId, deps, completedMap) {
  if (!Array.isArray(deps) || deps.length === 0) {
    throw new Error("promote requires non-empty deps array")
  }

  // 所有依赖必须已完成
  const notCompleted = deps.filter(d => !completedMap.has(d))
  if (notCompleted.length > 0) {
    throw new Error(`promote: deps not completed: ${notCompleted.join(", ")}`)
  }

  // 单依赖情况
  if (deps.length === 1) {
    const depId = deps[0]
    const atom = completedMap.get(depId)
    const ref = atom?.ref ?? 0

    if (ref > 0) {
      // inherit: ref > 0，直接继承并递减 ref
      atom.ref = ref - 1
      return {
        action: "inherit",
        primaryAtom: depId,
        toMerge: [],
        toRecycle: []
      }
    } else {
      // fork: ref=0，没有 slot，需要新创建
      return {
        action: "fork",
        primaryAtom: depId,
        toMerge: [],
        toRecycle: []
      }
    }
  }

  // 多依赖情况：acquire + merge
  // 选择 ref 最大的作为 primary（保留高 ref 的 atom 给其他依赖者，避免不必要的 recycle）
  let primaryDepId = null
  let maxRef = -1

  for (const depId of deps) {
    const atom = completedMap.get(depId)
    const ref = atom.ref ?? 0
    if (ref > maxRef) {
      maxRef = ref
      primaryDepId = depId
    }
  }

  // 其余依赖需要 merge
  const toMerge = deps.filter(d => d !== primaryDepId)
  
  // ref=0 的 atom merge 后应该被 recycle
  const toRecycle = toMerge.filter(depId => {
    const atom = completedMap.get(depId)
    return (atom.ref ?? 0) === 0
  })

  return {
    action: "acquire",
    primaryAtom: primaryDepId,
    toMerge,
    toRecycle
  }
}
