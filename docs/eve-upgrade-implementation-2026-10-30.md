# Eve 0.85.0 升级与消息运行时复盘

本次从 Eve 0.56.0 升级到 0.85.0，采用原生 v27 事件、AI SDK 7 和新的公开 sandbox provider API。删除旧 Eve 补丁、旧事件 reducer 和旧 sandbox backend 包装，不保留双协议运行逻辑。

## 五个问题的根因与处理

| 问题 | 根因与处理 |
| --- | --- |
| 编辑后立即停止出现重复用户消息 | 乐观消息、编辑投影和持久回执之间存在交接竞态。使用稳定的 clientMessageId 对齐同一条消息，收到对应的原生回执和可见行后才移除乐观副本；停止不再删除原始事件。 |
| 向上滚动后发送，Thinking 离用户消息很远 | 发送锚点、占位和底部留白未共同约束布局。统一新轮次的用户行锚点，保持用户行与助手占位相邻。 |
| 用户行上移后在响应开始时突然掉回底部 | 发送锚定与响应开始时的自动滚动竞争。响应沿用同一锚点，内容增长不重新触发到底部的跳转。 |
| 多次编辑、停止后顺序错乱 | 恢复事件按到达顺序追加、游标按数组长度推算，并混用了显示过滤与持久日志。现在保留完整原生事实，按 `(line, index)` 排序去重，按完整源行推进游标，分页和冲突合并遵守同一顺序。 |
| 停止后继续显示输出 | 本地网络中断被误当成服务端取消。点击停止立即冻结可见输出，继续读取持久流以定向取消并等待结算；接收回执前的停止保留取消意图，回执到达后绑定该轮次。 |

旧问题会话 `thread-1793161339572-sqwtaqp141i` 的数据库取证包含 92 条缓存事件：索引 62 已是 `turn_12` 之后的等待状态，索引 63 却追加了更早的 `turn_7`，其后还有 `turn_8`、`turn_10` 交错。问题已经进入持久缓存，不能仅归为 CSS 或前端排序。原始取证位于 `.tmp/problem-thread-open-agent-gate-data-agent_thread_events.json`，本次未覆盖这些证据。

## 运行时约束

- Eve 的 `view` 与完整事件流负责执行事实；消息列表只查询和投影这些事实。
- 一个源行可以包含多条事实。消息条数、事实条数、存储分页索引均不能替代 Eve 源行游标。
- 乐观行只表示尚未投影的用户输入，不成为第二份执行历史；重复的同文消息仍是不同轮次。
- 编辑由持久事务保存不可变前缀与 clear/send 进度。重试与进程重启复用同一事务，已开始的编辑取消仍保留取消意图。
- `send()` 返回 acceptance delivery，不表示轮次完成。取消 HTTP 的 accepted 回应同样不表示工作停止；以目标轮次的持久结算确认交接。
- 网络错误若导致首次 acceptance 回执不可确认，界面保留停止状态、保留原提示并显示错误，不自动重发或假定停止成功。没有 sessionId 时无法证明服务端是否接收，该极端网络场景仍需要用户恢复连接或另开会话。

停止的界面响应与服务端停止是两个边界。浏览器回归证明迟到内容不再追加显示；它不能证明远端 Provider 或所有工具在零毫秒内停止。工具通过 Eve 的 signal 使用协作取消，Docker provider 的真实测试覆盖进程树终止与资源限制。

## 官方升级带来的帮助

v27 提供不可变源位置、明确的 delivery/turn/model/call/task 边界和官方 conversation 查询，减少了本项目自行推断运行时状态的代码。原生 steering 和子代理 task 生命周期替代了旧 Eve 补丁；公开 sandbox provider API 保留本项目的限流、资源限制、空闲释放与重连策略。

官方升级不会自行修复本项目的乐观行交接、持久缓存合并或滚动布局。上述五项修复需要应用层一起调整。

参考安装包文档：

- `node_modules/eve/docs/concepts/upgrade-to-v27-events.md`
- `node_modules/eve/docs/concepts/sessions-runs-and-streaming.md`
- `node_modules/eve/docs/guides/client/streaming.mdx`
- `node_modules/eve/docs/subagents/index.mdx`

旧浏览器事件数组不能直接作为 v27 initialEvents；缓存失效后从源流位置 0 重读。官方仅支持特定版本已有会话的自动运行迁移，0.56.0 不在该范围内，旧运行不能承诺直接续跑。本项目不保留旧部署或兼容执行层；测试旧运行后应新建会话。已有数据库与取证不作删除。

## 验证与体验实例

- Node.js 24 类型检查与 SDK 构建通过，工作树差异格式检查通过。
- 19 个浏览器场景通过：桌面、移动端、输入、附件入口、编辑/停止、回执竞态、连续同文消息、滚动锚定、刷新、断流恢复及存储冲突。
- SDK tarball 的 npm、无 Eve 的 headless npm、pnpm 三种安装和导入场景通过；验证脚本从项目依赖读取 Eve 版本。
- Next.js 生产构建及 embed CSP 检查通过。前序 Eve 构建、全量单元回归、13 项 PostgreSQL 编辑/排序回归、Provider 恢复、MCP conformance 与真实 Docker provider 测试均已通过。
- 浏览器验证使用隔离端口 3201/4280 和独立 Workflow 数据库；不接入体验实例的任务队列。

已将相同源码按现有部署环境重新构建并切换 `open-agent-preview.service`，重启后再次完成全部 19 项浏览器回归（30.8 秒）。3100/3101 页面返回 HTTP 200，3100 转发的 Eve 健康接口返回 ready；生产代理端口与 embed CSP 均与原部署一致。独立验证服务已停止，临时 Workflow 数据库已移除。

前一生产构建保留在 `.tmp/rollback-builds/next-before-admission-fix-20261030`（生产回退无需的 dev/cache 已清理）。本次构建与验证日志位于 `.tmp/eve-upgrade-2026-10-30/`，浏览器日志位于 `.tmp/eve-upgrade-browser-20261030.log`。

用户要求暂停的四个 Muses `saas-*` Docker 容器保持停止，未删除容器或卷。open-agent 的基础设施继续运行。

## 快速取消与停止后立即重发补充

2026-10-31 对 PostgreSQL Workflow world 的实际取消做了隔离验证。Eve 的取消命令会作为同一 session 的另一条 wake 交付；`@workflow/world-postgres@5.0.0-beta.44` 对同一 workflow run 做排他串行，因此正在 inline 执行模型步骤时，取消 wake 无法进入并触发中止。官方 `5.0.0-beta.45` 移除了这层 run 级排他，源码明确注明取消 wake 必须能与持有 inline step 的 delivery 并行。项目将依赖精确升级到 beta.45，取消机制采用官方实现；既有的流读取分页、去重和监听器管理补丁继续保留，2026-11-05 已将补丁文件对齐到 beta.45 并通过全部 7 项流读取回归。该补丁不修改取消调度逻辑。该版本的生产 schema 需先执行官方 setup/migration。

用户点击停止时，界面立即冻结旧轮输出，同时保留旧 turn 的取消目标；停止期间的新消息直接提交给 Eve 并设置 `turnPolicy: "queue"`。服务端取消与下一条 delivery 并行进入 Workflow world：取消先结算时，下一条消息创建新的 turn；消息先到时，Eve 将其保留到旧 turn 停止后执行。并发 PostgreSQL 验证中的旧 turn 取消耗时为约 85–124ms，取消后紧接提交的新 turn 约 119–152ms 完成；等待响应头及已有流式响应在服务端分别于 55ms、29ms 关闭。这里的毫秒数据是在本机测试容器和合成模型下测得，网络、模型供应商与 sandbox 负载仍会影响时延。

集成验证还发现 Docker provider 的 `setsid` 在自己成为进程组组长时会 fork 后退出，Docker 因此可能过早报告成功，而 sleep 子进程仍继续运行。provider 现在使用 `setsid --wait` 等待目标命令，并在取消时冻结父进程、递归结束 `/proc` 中的后代进程，再等待 exec 退出。真实 Docker 回归覆盖 Eve 的 job-control shell、分离进程组、嵌套 `setsid`、退出码、后台进程清理，并确认另一个 sandbox exec 不受影响。

刷新和首次 session 回执存在额外竞态：用户在创建 session 的首个 POST 尚未确认时停止并再次发送，最新 pending turn 会替换旧 pending turn。停止标记现在持久保存旧 clientMessageId 和临时消息快照，直到 Eve 的用户消息进入投影后再清除；迟到的旧取消回执不能绑定或冻结新 turn。浏览器回归覆盖首次回执前停止重发、取消回执迟到后立刻重发并再次停止，以及停止重发后刷新。

新增可重复的真实 Eve 取消验证：`npm run verify:cancellation`。它默认运行等待模型响应、已有流式输出和正在执行 shell 命令三个场景；生产 Workflow world 验证须设置指向隔离数据库的 `WORKFLOW_POSTGRES_URL` 和 `VERIFY_EVE_BUILT_RUNTIME=1`，不可指向仍承载体验实例的数据库。Docker provider 回归可用 `TEST_DOCKER_SANDBOX_IMAGE=ghcr.io/vercel/eve:dockerfile-fc0279bf1664 node --test tests/unit/docker-sandbox-provider.test.ts` 运行。2026-10-31 的验证结果：40 项相关单元测试通过、三项取消竞态浏览器测试通过；完整前端回归与最终部署状态以本次执行日志为准。

## 2026-10-31 beta.45 体验切换

最新源码以体验环境的 embed origins 和 Eve 端口重新执行 `npm run build`，Next.js、TypeScript、路由生成和 embed CSP 检查均通过。停机期间通过安装包自带的 `@workflow/world-postgres@5.0.0-beta.45` `bootstrap` 将体验库从 0019 升至 0022；迁移历史共 23 条，`workflow.workflow_invocations` 已创建。迁移前的 Workflow 数据库快照保存在 `.tmp/eve-upgrade-2026-10-31/workflow-before-beta45.dump`。

`open-agent-preview.service` 已在新构建上启动。3100 网关、3101 Next 和 4275 Eve 的健康检查均返回 HTTP 200，Eve 状态为 `ready`；另以独立新会话完成真实模型回合，返回预期 smoke 标记。当前源码的 22 项浏览器回归全部通过，覆盖编辑后立即停止、取消回执前重发、刷新恢复、消息顺序、滚动锚点及停止期间重发。

体验 Workflow 库仍保留 29 条历史 stranded run，最后更新时间不晚于 2026-10-28。Eve 0.85.0 启动时按版本保护逻辑跳过其自动恢复；没有删除这些记录。四个 `saas-*` Muses 容器仍保持停止。
