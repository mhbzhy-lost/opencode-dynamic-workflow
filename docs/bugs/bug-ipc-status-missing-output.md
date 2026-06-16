# Bug: IPC status.json 完成时缺少 output 字段

## 现象

agent 完成后，`.workflow/status.json` 中对应 agent 的记录只有
`status: "completed"` 和 `durationMs`，没有 `output` 字段。
dashboard 和 status.json 的 result/error 栏始终为空。

失败时 `error` 字段正常写入，行为不对称。

## 根因

`runner.mjs:146-149` — `updateAgentStatus` 调用在成功路径上没有传 `output`：

```js
// 成功路径（缺少 output）
ipc.updateAgentStatus(agentId, {
  status: "completed",
  durationMs,
})

// 失败路径（正确传了 error）
ipc.updateAgentStatus(agentId, {
  status: "failed",
  error: err.message,
  durationMs,
})
```

`return` 语句正确返回了 `{ output }` 给调用方，但 IPC 层没收到这个值。

## 影响范围

- `.workflow/status.json` 中 agent 输出永远为空
- `dashboard.html` 无法展示 agent 输出
- 任何读取 IPC status 的外部工具/脚本拿不到结果

不影响 workflow 脚本本身的返回值（`wf.agent()` / `wf.parallel()` 的返回值正常）。

## 修复方案

在成功路径的 `updateAgentStatus` 调用中加入 `output` 字段。

## 验证方式

单元测试：mock IPC 后验证 `updateAgentStatus` 被调用时包含 `output` 字段。
