# Eve 0.56.0 实施记录与发布检查

日期：2026-09-16。

## 当前结论

升级代码已合并到 `main`，开发体验实例已于 2026-09-19 切换到 Eve 0.56.0。旧的 Eve 0.31 服务与独立 `3200` 前端已停止，当前仅保留 systemd 管理的 `3100` 网关、`3101` Next、`4275` Eve 以及必要后台 worker。

已确认的跨版本限制不是 UI 推测：旧版创建的 Workflow run 在新版首次继续请求时会发生持久化 step ID 重放分歧。这是 Eve/Workflow 的版本化执行记录约束，不是数据库物理损坏。用户已确认当前没有真实用户依赖旧会话，因此本次升级**不承诺旧运行时会话的跨版本承接或在线迁移**。正式切换前只允许针对明确的开发/测试 Workflow 数据库执行清理或重建；不得对生产数据库做未经确认的删除。

本次切换使用的 `open-agent-gate-world` 与 `open-agent-gate-data` 已确认属于开发体验实例。切换前分别完成逻辑备份，随后重建 Workflow 和 Open Agent 应用 schema，并使用 Eve 0.56 对应的 `@workflow/world-postgres bootstrap` 与项目迁移重新初始化。MinIO 对象存储及基础设施 volume 未删除。

## 已完成

- 锁定 eve 0.56.0、ai 7.0.93、PostgreSQL World 5.0.0-beta.44，更新相应 SDK peer 和分发产物。
- 适配动态模型的新返回契约，移除旧 fallback、无效的 sibling 配置及已默认启用的子代理实验项。
- 新消息流使用原生 v25 增量；保留旧累计快照读取，并为分页恢复生成累计界面投影。原始持久流不恢复为逐字累计全文。
- 迁移安全边界追加、真实上下文编辑回退、消费前 admission guard、稳定消息身份、403/404 容错与重试事件。
- 复用新版有序 emitter 和清理机制，保留有界工具输入合并、前端通知节流、PG 分页及精确 chunk 去重。
- 保留空 skill 不创建沙箱、空闲回收和配额；适配新增 stop/delete 接口。
- 区分子代理后台受理回执与真正完成，避免 `subagent.completed` 的新语义提前终止展示。
- 未调整消息字号、间距、action-bar、滚动策略；未新增 tokenizer、部署预览或多宿主运行时架构。
- 旧版本补丁已替换为匹配新版的补丁，升级提交已快进合并到主工作区。
- 已移除旧客户端专用的 thread collection PUT 全量快照入口；当前客户端只使用 PATCH 增量存储。v25 分页、断流恢复和 server transcript repair 仍服务于当前会话正确性，不作为旧版本包袱删除。

## 验证结果

| 验证 | 结果与边界 |
| --- | --- |
| 新版单元测试 | 最终 643 项通过，含增量恢复、后台受理和既有回归。移除了依赖旧 bundle 文件形态的源码正则测试，保留实际通知频率、事件完整性和快照不可变测试 |
| TypeScript | 通过 |
| Eve 后端生产构建 | 通过 |
| Next 生产构建 | 通过；`AGENT_EMBED_ALLOWED_ORIGINS=https://example.com npm run build`，嵌入 CSP 校验通过 |
| 补丁可重复应用 | 在原始 npm 包对应文件上通过 git apply，并逐文件确认应用结果等于被测依赖 |
| 真实 PostgreSQL、可控 Provider | 403/404/429/408/5xx、超时、断流的真实重试及同会话继续通过；重试次数由 mock Provider 实际请求数验证 |
| 真实沙箱 | 顺序两个会话的 reset 后配额释放、复用通过 |
| 新版创建会话，再重启新版 | 对话恢复及编辑请求通过；直接检查模型 input，确认保留前两轮上下文并移除被编辑轮的旧用户输入和旧答案 |
| 旧版创建会话，再重启新版 | 按已确认的发布策略不支持跨版本承接；仅保留诊断证据，不作为新版功能失败 |
| 开发体验运行状态 | 新服务 health 返回 ready；旧开发会话不迁移，应用与 Workflow schema 已重建 |

切换后 smoke 使用新的 standalone 身份创建真实会话 `wrun_01M2WAQ83MMJ01P5K0734D086E`。流声明 Eve `0.56.0`、协议 `v25`，模型返回 `READY`，随后产生 `turn.completed` 和 `session.waiting`。`/eve/v1/health` 与 Web 根路由均返回 HTTP 200。

实际运行验证使用独立数据库 `open_agent_eve_upgrade_test` 和 `open_agent_eve_migration_test`，独立队列前缀与端口。测试进程已退出。测试库保留用于复核，无生产数据删除或改写。

开发模式验证曾因启动子进程被 SIGKILL 而失败，已改用构建产物和独立 PostgreSQL 验证；这不是模型调用失败，也不能当作开发服务器已通过。

## 跨版本限制证据

测试会话：`wrun_01M2N57CXK85N63WV5NFV4ETF0`，仅存在于独立迁移测试库。

1. 旧版完成两轮对话，读取到 17 个事件。
2. 停止旧版测试进程，迁移测试库 schema，启动新版测试进程。
3. 对同一 sessionId 继续发送消息。
4. Workflow 报 REPLAY_DIVERGENCE，重放恢复预算耗尽后报 CORRUPTED_EVENT_LOG，测试根 run 变为 failed。

关键诊断：

```text
step event step_created ... belongs to "step//eve@0.31.1//createSessionStep",
but the current step consumer is "step//eve@0.56.0//createSessionStep"
```

这里的 CORRUPTED_EVENT_LOG 是新版对不兼容重放的错误分类，不表示生产库发生物理损坏。

源码对应：
- `eve/src/internal/workflow-bundle/workflow-transformer.ts` 明确保留版本化 step ID。
- `eve/src/execution/durable-session-migrations/turn-workflow.ts` 的兼容前提是旧 driver 保持在旧部署，新 turn 可路由到新部署。
- 本项目单实例直接替换时，没有保留旧部署执行旧 driver 的能力。输入 schema 迁移和旧流格式兼容不能代替这一层。
- 新 Workflow runtime 明确校验记录中的 stepName 与当前消费者一致。不能删除此校验、伪装包版本或批量替换旧日志来“修复”。

## 仍未验收

- 完整浏览器交互、连续 ask/审批、真实子代理后台结果回传与父子取消。
- 真实运行中的安全边界追加、多条追加、编辑消费守卫及提交后刷新故障注入。当前主要是单元覆盖，不可等同端到端通过。
- 多模态、动态 skill/MCP、多宿主隔离的新版端到端验收。
- Next 构建、首 token / 长工具流延迟比较、并发和磁盘/内存负载、归档恢复与生产回退演练。
- 沙箱新增删除生命周期的并发边界、后台任务取消语义与产品现有中断契约仍需复核。

## 后续生产验收

1. 在隔离服务和数据库上完成 Playwright E2E：追加 steering、编辑后刷新、连续 ask、审批、子代理、断流重连、停止/取消、长工具流、v25 增量流和附件/图片路径。
2. 完成并发、首 token、长工具流、内存/磁盘及归档恢复检查；新版自身恢复和编辑/追加正确性是发布门槛。
3. 面向真实用户部署前仍需使用目标生产数据库和沙箱后端完成备份恢复、容量和故障演练；本次开发体验实例的清理授权不能外推到未来生产数据。

不实施旧运行时共存路由、离线伪迁移、版本化 step ID 替换或新的 UI/沙箱架构；这些都会扩大复杂度且不能保证上下文正确性。

## 复核入口

- 安全回退点：`b157655cb617173e009c71910cd499b246ddf4c1`，GitHub 标签 `safety/pre-eve-upgrade-2026-09-16` 已推送。
- 升级工作区：`/tmp/open-agent-eve-upgrade-PwMAwq/app`。
- 完整日志和源码差异存档：主工作区 `.tmp/eve-upgrade-2026-09-16/`。
- 跨版本限制曾由独立迁移测试库复现；该证据仅用于发布决策，不作为线上迁移脚本或 CI 阻断项。
- Provider 回归：`scripts/verify-provider-failures.mjs`，VERIFY_EVE_BUILT_RUNTIME=1 使用已构建产物及明确指定的测试 PostgreSQL。
