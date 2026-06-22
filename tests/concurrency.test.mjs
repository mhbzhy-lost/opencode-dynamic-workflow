/**
 * T5.3: Concurrency Tests (Simplified)
 * 
 * 测试 PromotionCoordinator 的并发安全性（使用 mock completedMap）
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { promote, PromotionCoordinator } from "../lib/promote.mjs"

describe("T5.3: Concurrency Safety", () => {
  /**
   * 测试同时为同一 atom 的多个下游任务调用 promote
   * Scenario: A->B,C (ref=2 for A)
   * 期望：B inherit (ref: 2->1), C fork (ref: 1->0)
   */
  it("handles multiple tasks ready for same atom", () => {
    const mockAtom = { id: "atom-1", path: "/tmp/test" }
    const completedMap = new Map([
      ["A", { ref: 1, atom: mockAtom }]
    ])
    
    const coordinator = new PromotionCoordinator(completedMap)
    
      // B 和 C 都 ready，同时调用 promote
    const resultB = coordinator.promote("B", ["A"], completedMap)
    const resultC = coordinator.promote("C", ["A"], completedMap)
    
    // B 应该得到 inherit（ref 从 1 减到 0）
    // C 应该得到 fork（ref 已经为 0，需要新创建）
    assert.equal(resultB.action, "inherit", "B should inherit")
    assert.equal(resultC.action, "fork", "C should fork")
    assert.equal(completedMap.get("A").ref, 0, "Final ref should be 0")
  })

  /**
   * 测试不同 atom 的并发操作
   * Scenario: A->B, C->D, E->F (three separate chains)
   * 期望：所有 inherit 都成功
   */
  it("handles concurrent promotes across different atoms", () => {
    const atom1 = { id: "atom-1", path: "/tmp/1" }
    const atom2 = { id: "atom-2", path: "/tmp/2" }
    const atom3 = { id: "atom-3", path: "/tmp/3" }
    
    const completedMap = new Map([
      ["A", { ref: 1, atom: atom1 }],
      ["C", { ref: 1, atom: atom2 }],
      ["E", { ref: 1, atom: atom3 }]
    ])
    
    const coordinator = new PromotionCoordinator(completedMap)
    
    // 三个 promote 同时调用
    const resultB = coordinator.promote("B", ["A"], completedMap)
    const resultD = coordinator.promote("D", ["C"], completedMap)
    const resultF = coordinator.promote("F", ["E"], completedMap)
    
    assert.equal(resultB.action, "inherit")
    assert.equal(resultB.atom, atom1)
    assert.equal(resultD.action, "inherit")
    assert.equal(resultD.atom, atom2)
    assert.equal(resultF.action, "inherit")
    assert.equal(resultF.atom, atom3)
    
    // 所有 ref 都应该减到 0
    assert.equal(completedMap.get("A").ref, 0)
    assert.equal(completedMap.get("C").ref, 0)
    assert.equal(completedMap.get("E").ref, 0)
  })

  /**
   * 测试 ref 计数递减的原子性
   * Scenario: A->B,C,D (ref=3 for A)
   * 期望：B inherit (ref: 3->2), C inherit (ref: 2->1), D inherit (ref: 1->0)
   */
  it("correctly decrements ref count under concurrent access", () => {
    const mockAtom = { id: "atom-1", path: "/tmp/test" }
    const completedMap = new Map([
      ["A", { ref: 3, atom: mockAtom }]
    ])
    
    const coordinator = new PromotionCoordinator(completedMap)
    
    // B, C, D 同时 ready
    const resultB = coordinator.promote("B", ["A"], completedMap)
    const resultC = coordinator.promote("C", ["A"], completedMap)
    const resultD = coordinator.promote("D", ["A"], completedMap)
    
    // 所有都应该得到 inherit（ref 依次递减）
    assert.equal(resultB.action, "inherit", "B should inherit")
    assert.equal(resultC.action, "inherit", "C should inherit")
    assert.equal(resultD.action, "inherit", "D should inherit (last one)")
    
    // 最终 ref 应该是 0
    assert.equal(completedMap.get("A").ref, 0, "Final ref should be 0")
  })

  /**
   * 测试大量并发（10个任务依赖同一 atom，ref=5）
   */
  it("handles high concurrency", () => {
    const mockAtom = { id: "atom-1", path: "/tmp/test" }
    const completedMap = new Map([
      ["A", { ref: 5, atom: mockAtom }]
    ])
    
    const coordinator = new PromotionCoordinator(completedMap)
    
    // 10 个任务依次调用 promote
    const results = []
    for (let i = 0; i < 10; i++) {
      results.push(coordinator.promote(`Task-${i}`, ["A"], completedMap))
    }
    
    // 前 5 个应该是 inherit（ref 5->0），后 5 个应该是 fork（ref 已经是 0）
    const inherits = results.filter(r => r.action === "inherit")
    const forks = results.filter(r => r.action === "fork")
    
    assert.equal(inherits.length, 5, "Should have 5 inherits")
    assert.equal(forks.length, 5, "Should have 5 forks")
    assert.equal(completedMap.get("A").ref, 0, "Final ref should be 0")
  })
})
