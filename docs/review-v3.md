Installed 7 packages in 10ms
[external-llm-review] backend=api model=qwen3.7-max base=https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 diff_chars=60000 (truncated) review_depth=exhaustive review_round=1 max_issues=25 api_timeout_seconds=900
### Strengths
- **Root Cause Fix Verified**: The primary bug (missing `output` in IPC status) is correctly fixed in `lib/runner.mjs:214`, and crucially, covered by a specific unit test in `tests/runner.test.mjs`.
- **DAG Implementation Solid**: `lib/dag.mjs` implements topological sort and cycle detection correctly with O(V+E) complexity. Tests cover diamond dependencies and cycles well.
- **Dashboard UX Improvement**: Moving from static HTML refresh to a hybrid approach (meta refresh + JS live timer) in `lib/dashboard.mjs` significantly improves perceived performance for running agents.
- **Worktree Isolation**: The new `lib/worktree.mjs` provides a clean abstraction for git worktree lifecycle, correctly handling branch creation and cleanup fallbacks.

### Issues

#### Critical (Must Fix)

1.  **ReDoS Vulnerability in DAG Prompt Interpolation**
    -   **File**: `lib/runner.mjs:456-458`
    -   **Evidence**: `prompt.replace(new RegExp(`\\{\\{${dep}\\.output\\}\\}`, "g"), ...)`
    -   **Trigger**: If `dep` ID contains regex special characters (e.g., `task.a`, `node[1]`, `a+b`), `new RegExp` interprets them as regex operators. A malicious or malformed ID like `(a+)+` could cause catastrophic backtracking (ReDoS). Even benign IDs with dots (`feat.branch`) will fail to match because `.` matches any char instead of literal dot.
    -   **Fix**: Escape `dep` before constructing RegExp, or use `String.prototype.replaceAll` (Node 15+) / split-join pattern which treats input as literal string.

2.  **Process CWD Mutation Breaks Concurrent Workflows & Path Resolution**
    -   **File**: `lib/runner.mjs:360`
    -   **Evidence**: `process.chdir(worktreeState.path)`
    -   **Trigger**: `createWorkflow` changes the *global* process working directory. If multiple workflows are instantiated (e.g., in tests or future orchestrator), or if post-worktree code uses relative paths assuming original CWD, they will resolve against the wrong directory. This is a global side effect in an async factory.
    -   **Fix**: Avoid `process.chdir()`. Pass absolute paths to `ensureServer` / `execFile` via `cwd` option instead. If `opencode serve` strictly requires CWD, document this limitation and add a guard against concurrent instantiation.

3.  **Command File Read Race Condition (Partial Write)**
    -   **File**: `lib/runner.mjs:34-42`, `lib/ipc.mjs:12-20`
    -   **Evidence**: `existsSync(path)` followed by `readFileSync(path)` + `JSON.parse`
    -   **Trigger**: Main agent writes `agent_prompt_<id>.json`. If workflow polls between file creation and write completion, `readFileSync` may read partial JSON, causing `JSON.parse` to throw. In `readPrompt`, this returns `null` (silent retry). In `needPrompt`, it throws hard error, crashing the wait loop.
    -   **Fix**: Use atomic write pattern on writer side (write to `.tmp`, rename). On reader side, catch parse errors in `needPrompt` and treat as "not ready yet" rather than fatal, OR require atomic writes in protocol spec.

#### Important (Should Fix)

4.  **Silent Swallow of Dashboard Refresh Errors**
    -   **File**: `lib/runner.mjs:413`
    -   **Evidence**: `catch (_) { /* swallow */ }`
    -   **Impact**: If `renderDashboard` fails repeatedly (e.g., permission issue, disk full), user gets no indication that dashboard is stale. Debugging becomes impossible.
    -   **Fix**: Log first error or sample errors periodically: `if (!loggedErr) { console.error(...); loggedErr = true }`.

5.  **Event Name Mismatch Between Docs and Implementation**
    -   **File**: `lib/events.mjs:2` vs `lib/runner.mjs:47`
    -   **Evidence**: `EVENTS.NEED_AGENT = "need_agent"` but `needPrompt()` emits `[workflow:need_prompt]`.
    -   **Impact**: External consumers using `EVENTS.NEED_AGENT` constant will never match the actual stdout line. Documentation says `need_agent`, code does `need_prompt`.
    -   **Fix**: Align constant name and emitted string. Add integration test verifying event round-trip.

6.  **Worktree Branch Name Injection in Git Commands**
    -   **File**: `lib/worktree.mjs:14, 97`
    -   **Evidence**: `["worktree", "add", "-b", branch, path, baseBranch]`
    -   **Impact**: While `execFile` prevents shell injection, invalid branch names (spaces, `..`, control chars) will cause cryptic git failures. No validation on `branch` parameter.
    -   **Fix**: Validate `branch` against `/^[a-zA-Z0-9._/-]+$/` before passing to git.

7.  **Dashboard XSS via Agent Output (Insufficient Escaping Context)**
    -   **File**: `lib/dashboard.mjs:72`
    -   **Evidence**: `<td>${esc(truncate(a.output || a.error, 80))}</td>`
    -   **Impact**: `esc()` likely escapes HTML entities, but verify it handles all contexts. If `esc` is naive (e.g., only `<>&`), attribute injection in other fields or future template changes could be risky. More importantly, truncated output might break HTML structure if truncation cuts mid-entity.
    -   **Fix**: Verify `esc()` implementation covers `"`, `'`, `/`, `` ` ``. Ensure truncation doesn't produce invalid UTF-8 or partial entities.

8.  **`waitForCommand` Timeout Error Lacks Diagnostic Context**
    -   **File**: `lib/ipc.mjs:27`
    -   **Evidence**: `throw new Error(\`timeout waiting for command ${type}_${id} after ${timeout}ms\`)`
    -   **Impact**: Doesn't include `commandsDir` path. User can't tell *where* it was looking.
    -   **Fix**: Include resolved absolute path in error message.

9.  **`advancePhase` Non-Atomic Read-Modify-Write**
    -   **File**: `lib/ipc.mjs:148-153`
    -   **Evidence**: `readStatusFile` → mutate → `writeStatusFile`
    -   **Impact**: If two parallel agents complete simultaneously and both trigger phase advance (unlikely but possible in DAG layer transitions), one update may be lost. Status file corruption risk.
    -   **Fix**: Use file locking (`proper-lockfile`) or atomic counter file separate from status.json.

10. **`detectCycles` Returns Duplicate/Overlapping Cycles**
    - **File**: `lib/dag.mjs:55-68`
    - **Evidence**: DFS-based cycle detection pushes `path.slice(start)` for every back-edge.
    - **Impact**: In complex graphs, same logical cycle may be reported multiple times with different starting points. Consumers may over-report issues.
    - **Fix**: Normalize cycles (rotate to min node) and deduplicate before returning.

11. **Missing `finishedAt` in Success Path Test Assertion**
    - **File**: `tests/runner.test.mjs:175-180`
    - **Evidence**: Test asserts `output` and `status` but not `finishedAt`, despite fix adding it at `runner.mjs:215`.
    - **Impact**: Regression risk — `finishedAt` could be removed without test catching it. Dashboard duration display depends on it.
    - **Fix**: Add `assert.ok(agentStatus.finishedAt)` to test.

12. **`readPrompt` Silently Returns Null on All Errors**
    - **File**: `lib/runner.mjs:34-42`
    - **Evidence**: `catch { return null }`
    - **Impact**: Permission errors, I/O errors, and malformed JSON all return `null` indistinguishably. Caller can't differentiate "not ready" from "broken".
    - **Fix**: Only return null for ENOENT. Throw or log other errors.

#### Minor (Nice to Have)

13. **Magic Numbers for Polling**
    - **File**: `lib/runner.mjs:17-18`
    - **Evidence**: `POLL_INTERVAL_MS = 200`, `POLL_TIMEOUT_MS = 60_000`
    - **Suggestion**: Make configurable via `config.promptPollInterval` / `config.promptTimeout` for slow CI environments.

14. **Dashboard Script Uses `var` Instead of `const/let`**
    - **File**: `lib/dashboard.mjs:110-125`
    - **Evidence**: `var sec`, `var cells`, `var now`
    - **Suggestion**: Modernize to `const/let` for consistency, unless targeting IE11 (unlikely for dev tool).

15. **Unused Import in `runner.mjs`**
    - **File**: `lib/runner.mjs:3`
    - **Evidence**: `import { readFileSync, existsSync } from "node:fs"` — `readFileSync` used, but verify `existsSync` isn't redundant with `readPrompt` internal usage.
    - **Suggestion**: Audit imports; tree-shaking won't help in Node ESM runtime.

16. **Test Helper Duplication**
    - **File**: `tests/need-prompt.test.mjs:10-40`
    - **Evidence**: Comment says "duplicated from runner.test.mjs"
    - **Suggestion**: Extract `createMockClient`, `createMockIpc` to shared `tests/helpers.mjs`.

17. **`topoSort` Uses Array.shift() in Loop**
    - **File**: `lib/dag.mjs:28`
    - **Evidence**: `queue.shift()` is O(n) per call.
    - **Suggestion**: Use index pointer or deque for large DAGs. Negligible for <100 nodes but worth noting.

18. **Inconsistent Error Message Language**
    - **Files**: Mixed Chinese/English in errors and logs
    - **Suggestion**: Standardize on English for machine-readable errors, Chinese for user-facing CLI output only.

### Checklist Coverage

| Dimension | Status | Notes |
|-----------|--------|-------|
| Spec compliance | ✅ | Bug fix matches analysis; DAG/worktree features align with plan |
| Entry params / dry-run | ⚠️ | No dry-run mode for worktree creation; always mutates git state |
| Temp files / cleanup | ✅ | Worktree remove has rm -rf fallback; temp dirs in tests cleaned |
| Shell compatibility | N/A | Uses execFile, not shell; no bash/zsh concerns |
| Subprocess error diagnosis | ⚠️ | Git errors wrapped but stderr not always preserved in message |
| Idempotency / rollback | ⚠️ | Worktree create not idempotent (fails if branch exists); no rollback on partial DAG failure |
| Input boundary / path safety | ❌ | ReDoS in interpolation; no branch name validation; command file race |
| Concurrency / state sharing | ⚠️ | process.chdir global mutation; status file RMW race |
| Test coverage of root cause | ✅ | Direct test for IPC output field; DAG tests comprehensive |
| Async hygiene | ✅ | Blocking fs ops isolated to sync helpers or acceptable in CLI context |
| API deprecation | ✅ | No deprecated APIs detected |
| Security / data leakage | ⚠️ | Agent output rendered in dashboard (escaped); prompt content in stdout events (expected) |

### Assessment

**Ready to merge?** With fixes

**Reasoning:** Core bug fix is correct and tested, but the ReDoS vulnerability in DAG interpolation and global `process.chdir()` side effect are critical blockers for production use. Command file race condition also needs addressing before reliable deployment. Fix these three Critical items plus align event names, then safe to merge.
