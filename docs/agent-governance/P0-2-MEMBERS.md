# P0-2 成员管理契约（D-M1=A / D-M2=C）

- 状态：FROZEN（Owner 已选 D-M1=A 邮箱邀请；D-M2=C Owner 转让/离开）
- 范围：服务端成员 API + Web 共享面板；不改索引/权限模型
- 权限：仅 Owner（`canManageMembers`）可管理成员；非 Owner 一律 403/404 非泄露

## API

### `GET /api/documents/:id/members`

- Owner only；返回 `{ members: [{ userId, email, name, role }], ownerId }`
- 不存在的文档/无 membership → 404 `not_found`；非 Owner 成员 → 403 `forbidden`
- 不含任何 token/secret

### `POST /api/documents/:id/members`

- body `{ email: string, role: 'viewer'|'commenter'|'editor' }`
- Owner only；email 必须是**已注册用户**（Clerk `app_user.email`，demo 为 `*@insighthub.test`）
- 未知邮箱 → 404 `user_not_found`（统一，不区分“没这个人/不可邀请”）
- 已是成员 → 更新 role（幂等）；不能把成员设为 owner（owner 只能通过转让）
- 不能邀请自己（已是 owner）→ 409 `already_owner`
- 200 返回更新后的成员

### `PATCH /api/documents/:id/members/:userId`

- body `{ role: 'viewer'|'commenter'|'editor' }`
- Owner only；目标是 owner → 409 `owner_role_immutable`（请用转让）
- 200 返回成员

### `DELETE /api/documents/:id/members/:userId`

- Owner only；目标是 owner → 409 `owner_requires_transfer`
- 成功后立即失效该用户对该文档的访问：HTTP 下次 404/403；活跃 WS 连接必须被关闭（策略关闭码，测试断言）

### `POST /api/documents/:id/owner`

- body `{ userId: string }`（必须是当前成员，且不是当前 owner）
- Owner only；原子地把目标设为 owner，原 owner 降为 `editor`
- 保证文档始终恰好一个 owner；失败不改任何行

### `POST /api/documents/:id/leave`

- 当前用户离开文档：非 owner 删除自己的 membership
- owner 必须先转让；若仍是 owner → 409 `last_owner`
- 成功 204

## 数据

- 复用 `authz_document_membership`；新增唯一约束/索引已有主键 `(document_id, user_id)`。
- 用户目录：`app_user.email`（Clerk）；demo 额外映射
  `ada@insighthub.test` / `grace@insighthub.test` / `linus@insighthub.test`。
- 所有变更在单个 SQLite 事务内；owner 转让为“降原 owner + 升目标”同事务。

## 实时撤权

- 成员被移除/降级/转让后，已连接的 WebSocket 不能继续写：
  - 服务端对受影响用户在该文档的活跃连接发送关闭帧（1008 policy violation），或每帧重新鉴权并拒绝；优先关闭并测试。
  - 重连后按新 membership 决定读写。
- 前端收到关闭后显示中文“你的权限已变更，请重新加入”。

## UI（A2）

- 文档头 Owner 可见“共享”按钮 → 面板：
  - 成员列表（姓名/邮箱/角色）
  - 邮箱 + 角色邀请
  - 改角色、移除、转让 Owner、离开
  - 最后 Owner 保护、错误中文提示
- 非 Owner 不渲染入口；直接调用 API 仍被服务端拒绝。
