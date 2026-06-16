# Dynamic Workflow 重构计划 (v3)

## 核心约束

| 约束 | 说明 |
|------|------|
| **R1** | 仅最终 merge 回到主工作区（main），中间 merge 在 worktree 间累加完成 |
| **R2** | 本重构任务使用普通方式执行（subagent），不使用 dynamic workflow 自身 |
| **R3** | prompt 由主 Agent 控制；workflow 只做需求声明和转译；每次创建 subagent 都是同步屏障 |

## R1 实现：Worktree 累加器模式

### 生命周期示例

```
准备阶段:
  创建基准 worktree:
    git worktree add .workflow/wt-phase-1 main
    cd .workflow/wt-phase-1

Phase 1 (并发任务 A, B):
  从基准创建:
    git worktree add .workflow/wt-A feat/A
    git worktree add .workflow/wt-B feat/B
  任务 A 完成 → 提交到 feat/A
  任务 B 完成 → 提交到 feat/B
  
  merge gate (中间):
    选择 wt-phase-1 作为累加器
    git merge feat/A into wt-phase-1
    git merge feat/B into wt-phase-1
    清理: rm wt-A, wt-B, feat/A, feat/B

Phase 2 (串行任务 C):
  从累加器创建:
    git worktree add .workflow/wt-C feat/C (off wt-phase-1)
  任务 C 完成 → 提交到 feat/C
  
  merge gate:
    merge feat/C into wt-phase-1
    清理

Phase 3 (最终):
  唯一回主工作区:
    cd 主工作区
    git merge wt-phase-1
    git worktree remove .workflow/wt-phase-1
```

### 关键原则

1. **累加器选择**：每个 Phase 选择一个 worktree 作为累加器（通常是 phase 基准 worktree）
2. **中间 merge**：其他任务分支 → 累加器分支，合并后清理
3. **最终 merge**：累加器分支 → main，完成后清理累加器
4. **冲突处理**：中间 merge 冲突由主 Agent 判断；最终 merge 冲突由用户介入

## R2 执行策略

本任务使用 subagent 并行执行，不使用 dynamic workflow：

```
主 Agent
├── 子任务 1: lib/worktree.mjs
├── 子任务 2: lib/events.mjs (后台 subagent, background: true)
└── 等待合并
    ├── 子任务 3: lib/dag.mjs (后台 subagent)
    └── 子任务 4: lib/merge-gate.mjs (后台 subagent)
```

## R3 实现：双向通信协议

### 事件流

```
主 Agent 启动 workflow
  ↓
workflow 输出 [workflow:dispatched]
  ↓
workflow 输出 [workflow:need_agent] {"spec": {type, deps, ctx}}
  ↓
主 Agent 构造 prompt，写 commands/agent_prompt_<id>.json
  ↓
workflow 读取 prompt，创建 subagent（同步屏障）
  ↓
subagent 完成 → 事件循环
  ↓
workflow 输出 [workflow:completed]
  ↓
主 Agent 调用 wf.shutdown()
```

### prompt 控制机制

1. **workflow 声明需求**：`need_agent` 事件包含 `{type, deps, ctx}`
2. **主 Agent 构造 prompt**：读取事件，基于依赖任务输出构造 prompt
3. **命令文件**：写入 `commands/agent_prompt_<id>.json`
4. **workflow 读取**：轮询并读取命令文件，获得 prompt
5. **创建 subagent**：使用主 Agent 提供的 prompt

## 子任务列表

### 子任务 1: git worktree 扩展 (P0)

**目标**：实现 worktree 生命周期管理

**功能点**：
- `createWorktree(repoDir, branch, baseBranch)`：创建 worktree
- `removeWorktree(paths)`：批量清理
- `chooseAccumulator(worktrees)`：选择累加器
- `consolidatePhase(accumulator, others)`：合并其他分支到累加器

**验收标准**：
- TDD 完成（先写测试，再实现）
- 所有测试通过
- 支持 Phase 级别的 branch 命名（如 `feat/A`, `wt-phase-1`）

### 子任务 2: 双向通信协议 (P0)

**目标**：实现 workflow 与主 Agent 的同步通信

**功能点**：
- `events.mjs`：事件定义和输出
  - `[workflow:dispatched]`：workflow 启动
  - `[workflow:need_agent]`：请求 prompt
  - `[workflow:completed]`：workflow 完成
- `runner.mjs` 扩展：
  - `wf.needPrompt(spec)`：输出 `need_agent` 事件
  - `wf.readPrompt(id)`：读取 `commands/agent_prompt_<id>.json`
- 事件格式：JSON，包含 `id`, `type`, `timestamp`, `spec` 等

**验收标准**：
- TDD 完成
- 事件输出到 stdout（可被主 Agent 读取）
- 命令文件读取逻辑正确

### 子任务 3: DAG 编排 (P1)

**目标**：实现 DAG 拓扑和调度

**功能点**：
- `dag.mjs`：
  - `parseDAG(tasks)`：解析依赖关系
  - `topoSort(dag)`：拓扑排序
  - `detectCycle(dag)`：循环依赖检测
- 调度器：
  - 按 layer 执行（同一层并发）
  - 每层结束触发 `layer:done` 事件
  - 支持 DAG 中节点的 prompt 控制

**验收标准**：
- TDD 完成（覆盖循环依赖、多层 DAG、空 DAG）
- `dag` API 可调用（`wf.dag([{id, prompt, deps}])`）

### 子任务 4: Worktree merge gate (P1)

**目标**：实现 phase 间的 worktree 合并屏障

**功能点**：
- `merge-gate.mjs`：
  - 判断当前是中间 phase 还是最终 phase
  - 中间 phase：合并到累加器 worktree
  - 最终 phase：合并到 main，清理所有 worktree
- 与 DAG 集成：每层结束时自动触发

**验收标准**：
- TDD 完成
- 中间 phase 后 worktree 数量减少
- 最终 phase 后 worktree 被清理
- merge 冲突时返回错误

## 执行顺序

```
Step 1: 子任务 1 + 子任务 2 (并行)
  ↓
Step 2: 合并到 main
  ↓
Step 3: 子任务 3 + 子任务 4 (并行)
  ↓
Step 4: 合并到 main
  ↓
Step 5: 集成测试
```

## 验证方式

### 单元测试
- 每个子任务：`node --test tests/<name>.test.mjs`
- 覆盖率 > 80%

### 集成测试
- 使用 `workflows/parallel-research.mjs` 作为测试场景
- 验证：
  - worktree 正确创建/清理
  - 事件正确输出
  - prompt 正确读取
  - DAG 正确调度
  - merge 正确执行

### 回归测试
- 确保现有 `parallel-research.mjs` 继续工作
- 运行完整测试套件

## 风险与回退

| 风险 | 影响 | 回退方案 |
|------|------|----------|
| worktree 合并冲突 | 中间 phase 失败 | 主 Agent 介入，手动 resolved |
| 事件输出被截断 | 主 Agent 无法读取 | 增加缓冲区，确保 `\n` 刷新 |
| 命令文件读取失败 | subagent 无法创建 | 超时后返回错误 |
| DAG 循环依赖 | workflow 无法启动 | 提前检测，返回错误 |

## 不做的事

- **不做**：staging 分支（用户明确拒绝）
- **不做**：workflow 自动生成 prompt（R3 约束）
- **不做**：异步创建 subagent（R3 要求同步屏障）
- **不做**：本任务使用 dynamic workflow（R2 约束）

## 时间线

- 子任务 1 + 2：2-3 小时
- 合并 + 验证：30 分钟
- 子任务 3 + 4：3-4 小时
- 集成测试：1 小时
- 总计：**7-8 小时**

## 参考资料

- git worktree 文档：`git worktree --help`
- opencode-dynamic-workflow 现有架构：`vendor/opencode-dynamic-workflow/lib/`
- 类似工具实现：Claude Code Dynamic Workflows