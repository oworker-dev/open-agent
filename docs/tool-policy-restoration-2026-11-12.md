# 通用工具策略恢复与升级补丁复核

## 回归定位

`7e5b03d`（Eve 0.31.1）同时增加宿主工具配置和 Eve 运行时过滤。
`ab09370` 升级到 0.56.0 时替换旧补丁，但新补丁没有迁移
`readAllowedToolNames` / `agentRunPolicy` 过滤；`eb5c274` 的切换沿用了该状态。
`07addeb` 升级到 0.85.0 后删除旧补丁，也没有恢复此能力。
`dbc839a` 最近只对 ask_question 增加了模型中间件和审批限制。

因此历史上确实支持统一工具启停，失效始于 0.56 升级。
旧测试只验证配置解析和工具选择，没有检验真实运行时目录，导致遗漏未被发现。

## 本次实现

保留既有 `profile.allowedTools`、`profile.defaultTools`、`policy.tools`：
请求值优先于默认值，且不得超出 profile 上限；未配置保持编译默认，`[]` 禁用所有可选工具。

`patches/eve+0.85.0.patch` 在统一 step catalog 中筛选静态、动态、工作流、
子 agent 和 provider 工具。直接调用、`eve__tool`、目录搜索及审批恢复读取同一目录；
provider web search 在注入 SDK 工具之前就已被筛除。无会话的工具调用另在执行前检查同一授权。
授权取自持久化 auth，initiator 优先于当前调用者；损坏的策略拒绝执行，不回退成全部开放。

任务等待/取消、最终输出等运行时控制由 Eve 保留；Skill 和 MCP 使用各自授权，
不把 MCP 工具名称混入已编译工具 allowlist。子会话沿用 Eve 的 initiator 传递。
删除 ask 专用中间件和审批策略，ask 直接导出官方工作流工具。

这是项目特有的宿主授权，Eve 0.85 没有对应公开入口。使用集中补丁，
不为每个工具增加包装器。补丁通过既有 postinstall 的 patch-package 应用；
后续升级必须重做实际运行时验证，不能仅迁移配置类型。

## 旧补丁按能力复核

复核来源：`7e5b03d:patches/eve+0.31.1.patch`、
`ab09370:patches/eve+0.56.0.patch` 以及两次升级实施记录。

| 旧补丁能力 | 当前承接位置与结论 |
| --- | --- |
| 宿主工具过滤、provider search 过滤 | 确认遗漏，本次由统一 catalog 和直接调用授权恢复。 |
| 安全边界追加、编辑回退、消费守卫 | Eve 原生 delivery/steering/clear，应用 mailbox 的编辑事务与 admission guard；不恢复旧控制协议。 |
| 用户输入确认、乐观行和事件排序 | 原生 v27 源位置与 delivery，UI 的 conversation-messages、thread-storage、mailbox；原生事件不改写成旧累计快照。 |
| 工具输入/输出增量合并、有界顺序写入 | Eve ordered-stream-emitter 合并 call.input/content.delta，call.progress 保留最新快照；UI 直接使用 EveToolPart 与现有节流，不增加第二份流状态。 |
| 前端流订阅、分页恢复、精确去重 | Eve v27 客户端及项目 stream-range、thread-storage；PostgreSQL world 分页/监听修正仍由现有 beta.45 补丁提供。 |
| 空动态 Skill 不启动沙箱 | Eve reactions/kinds/skill 的延迟 prepare，markdown-only Skill 不产生待同步文件；已有 Skill 授权不变。 |
| Sandbox handle 生命周期、reset、空闲回收 | Eve 公开 sandbox provider、execution/sandbox/active-connections；项目 sandbox-compute-pool 和 Docker provider 保留配额、空闲回收及进程树取消。 |
| 子 agent 完成、任务与父子取消 | Eve 原生 task/agent-session 生命周期，UI turn-presentation 投影；不恢复旧 subagent.completed 推断。 |

此次复核在上述旧补丁能力组中，只确认工具过滤这一项遗漏。
现有测试可证明所覆盖路径的行为，不能替代所有远端宿主/MCP/沙箱后端的上线验收。

## 验证入口

- `tests/unit/eve-tool-policy.test.ts`：实际导入被补丁修改的 Eve 模块，逐个验证所有已编译工具；覆盖 provider injection、间接目录调用、任务控制、子会话继承、持久 auth 重建、审批恢复、独立 MCP 授权、损坏策略与无会话直接调用。
- `evals/fixed/tool-policy.eval.ts`：真实 Eve 会话中检查模型收到的工具列表；故意返回未提供的 shell、写文件、ask、子 agent 和间接工具调用，必须均未执行；已授权 checkpoint 正常执行。
- 原有 ask、审批、取消、压缩和文件操作 eval 继续运行。
- 补丁需在原始 npm 包上可重放，重放后的文件须与被测依赖一致。

本次结果：类型检查通过；全量单元 650 通过、1 跳过；固定 Eve eval
15 个场景、91 项断言全部通过；PostgreSQL Workflow world 后端生产构建通过。
原始 npm `eve@0.85.0` 重放补丁通过，三个修改文件与被测依赖逐字节一致。

本次不推送 GitHub，不部署体验服务；宿主工具 UI 扩展单独提交。
