# 执行中追加消息的展示边界修复

## 真实会话取证

截图 `屏幕截图 2026-11-05 222536.png` 对应会话 `thread-1793887593467-pled6y627a`，Eve session 为 `wrun_01M6P0MBT25ECY1K13SF2QC3TE`。只读导出的 4,540 条原生 v27 事件保持源位置有序。本次异常发生在前端展示投影，原始事件不需要数据修补。

同一个 turn 可以消费多次追加消息，并产生多条 assistant 消息。追加前的 run_6/7/8 对应 stepIndex 0/1/2；追加后的 run_9/10 对应 stepIndex 3/4。旧展示代码截取当前消息的事件后重新 fold，把后半段的 run_9 编成 step 0，再用完整日志读取 step 0 的思考内容和计时。因此后一条消息出现了前一段的 23 秒思考，随后又出现自己的 39 秒思考。

执行组还存在相同的边界问题：按 turn 查询全部工具和交互、隐藏 continuation 的组标题，以及按 turnId 回退查找另一条 assistant 消息，都会让多个追加片段互相影响。

## 修复约束

- 完整事件快照只做一次官方投影。真实 parts 保留官方的 stepIndex，空思考占位仅使用当前未结束 model run 在完整 turn 中的编号。
- 根据官方有序消息及相邻用户消息的 delivery.consumed 确定展示片段。事件切片只用于查询片段边界和时间，不重新 fold。
- 每条消息只使用自身的工具、交互和交付产物。执行组独立显示；新片段的审批或失败不改变旧片段状态。旧片段自己的后台工具与审批继续更新到结算。
- 两条追加消息在一次 commit 内被消费时，两个用户边界都保留，后续 assistant 内容跟随官方投影落在最后一个用户边界后。首个 assistant 尚无输出时也适用。
- assistant-ui 转换源按精确 message.id 匹配，不按 turnId 借用其他片段。

本次删除了历史 reasoning 重建与 continuation 隐藏分支，沿用 Eve 的消息与运行事实，没有新增持久消息状态或旧版本兼容层。工具输入的 call.input 增量累积、call.requested 参数定稿、call.progress 输出快照更新、call.settled 最终输出继续由官方投影处理。

## 升级遗留检查

全量单测发现既有 PostgreSQL world 流读取补丁仍标为 beta.44，安装 beta.45 后未生效。已将同一补丁对齐到已安装的 beta.45，恢复历史分页、重叠数据去重及监听器管理，保留升级前已有的能力。取消 wake 的并行调度继续使用 beta.45 官方实现。

活跃流的远端存储按 15 秒批量提交，前端检查点另有 250ms 的周期。新增回归的保存断言等待完整周期后才刷新；原先默认 15 秒的断言可能在保存前超时。产品保存周期没有改变。

## 验证

验证覆盖执行中连续追加、同一 commit 消费两条追加、首个输出前追加、旧片段后台调用和审批、工具输入增量与输出快照、断流重连及刷新。真实会话另以移动端回放，检查后一段只显示自己的 39 秒思考，无旧片段的 23 秒思考。

- 全量单测：637 项通过，1 项真实 Docker provider 测试因未设置测试镜像按配置跳过。流读取的 7 项回归全部通过。
- 完整 workspace 浏览器回归：27 项通过，包含本轮新增的连续追加与批量追加场景。
- 真实 PostgreSQL Workflow world 取消验证：等待响应头、流式响应、执行 shell 命令三个场景均通过。目标轮次结算耗时分别为 213ms、128ms、301ms；取消结算前立即发送的新消息均在自己的新 turn 完成。命令场景实际验证 Docker 进程终止。数据为本机合成模型测试结果。
- 真实会话回放：4,540 条源事件，6 条消息，末段单条 39 秒思考，浏览器 pageErrors 为空。
- TypeScript、SDK 构建、Eve 生产构建、Next.js 生产构建、embed CSP 与 diff 格式检查通过。
- 体验服务已使用 `.next-steering-final-20261105`，网关、Next 和 Eve 健康检查通过。

运行日志位于 `.tmp/steering-all-unit-final.log`、`.tmp/steering-workspace-e2e-final.log`、`.tmp/steering-cancellation.log`、`.tmp/steering-real-replay-final.log`、`.tmp/steering-typecheck-final.log`、`.tmp/steering-eve-build.log` 和 `.tmp/steering-final-release-build.log`。
