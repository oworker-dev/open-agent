# Embed 续签保留会话状态

对应问题报告：`/root/projects/saas/docs/internal/open-agent-embed-session-reset-on-token-refresh.md`。

## 已验证根因

在修复前运行的生产构建中，用允许的跨域父页面打开真实 `/embed`，选择已有会话、填写草稿，然后发送同一 service/storage/profile 的新 `agent.embed.configure`。
仅替换 token、expiresAt、requestId，即观察到 thread collection 索引 GET 从 1 次增加到 2 次。

原因是 Embed 的 client、threadStorage、mailbox 都依赖完整配置对象。续签重建了 threadStorage，触发 Workspace hydrate；没有指定线程时，hydrate 又优先新建临时线程，覆盖当前选择。该故障可以在 iframe document 没有重载的情况下发生。

## 实现

- 保留现有 configure 协议及逐条 requestId 确认。origin/source、同源 serviceUrl、配置结构和过期时间校验仍在更新配置前执行。
- 配置后的 Embed 以 serviceUrl、storageKey、profile ID/version 为生命周期边界；相同边界复用 client、threadStorage、mailbox 和 Workspace。
- 请求回调读取当前配置中的 token、runPolicy、clientContext，避免 Eve 创建 store 时捕获旧配置。每个生命周期持有自己的 ref，旧 scope 的异步工作不会读取新 scope 的凭据。
- token 续签不触发 hydrate，不替换当前输出流，不清理用户选择、消息、草稿和待处理审批。真正改变 service/storage/profile 时重新挂载 Workspace。
- Workspace 默认选择显式线程，其次选择有效的持久化 activeThreadId，再选择已有线程。没有可选线程时才创建临时线程。持久化基线同步记录恢复的选择。
- `initialThreadId={null}` 表示显式新任务；独立页面 `/` 使用此语义，已有 `/threads/:id` 路由和新任务草稿恢复行为不变。

无需修改 Host 发送逻辑、增加 token 消息类型、迁移数据或延长 token TTL。

## 验证

`tests/e2e/agent-embed.spec.ts` 在真实跨域 iframe 中覆盖：

1. 已选会话与草稿在续签后保留，collection 不重复加载，iframe 不重新导航。
2. 生成中的输出流不重开、不被中断，后续内容继续显示；新请求使用新 token、runPolicy、clientContext，持久化也使用新 token。
3. 待审批 UI 在续签后保留，批准操作通过 mailbox 携带新 token 和原 interaction ID 提交。
4. 刚切换线程时续签保留选择，实际刷新 iframe 后恢复持久化活动线程。
5. 失效的活动线程 ID 回退到已有会话；切换项目 storage scope 后加载新的 collection，清除旧运行视图。

回归同时运行原有 27 项 Workspace 浏览器测试，覆盖追加、编辑后立即停止、停止后立即发送、滚动定位、流重连、存储冲突和独立页面导航。

最终结果：32 项浏览器测试全部通过；单元测试 637 通过、1 项因缺少所需 Docker 镜像跳过；SDK 构建、TypeScript、Next 生产构建、Embed CSP 和 diff 检查通过。本地体验服务已切换至 `.next-embed-renewal-20261106`，Web、Embed、Eve 健康请求均返回 200。

测试使用真实页面和浏览器 postMessage 安全边界，服务端以原生 Eve v27 事件和 HTTP fixture 驱动；不将此结果等同于已完成真实 Muses 账号的定时 JWT 续签或服务端鉴权验收。
