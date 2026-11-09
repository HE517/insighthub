/**
 * 简体中文的角色显示名（A2 UI 文案统一）。
 *
 * 角色值本身是共享协议的一部分（`DocumentRole`：`owner` / `editor` / `commenter` /
 * `viewer`），必须原样保留在 `session.getRole()`、`room-joined.role`、`data-*`
 * 属性和测试中。这里只负责 **给人看的中文标签**，不改变任何协议字段。
 *
 * 未知角色（`null`）没有标签：调用方必须先确认角色已知，再渲染标签。这与
 * `readOnlyNoticeCopy.ts` / `DocumentHeader.tsx` 的“未知不猜测”规则一致
 * （`docs/CONTRACTS.md` §17.9，`AGENTS.md` R10）。
 */
import type { DocumentRole } from '@insighthub/shared';

/** 已知角色的中文名称。穷尽 `DocumentRole`，新增角色会在这里编译失败。 */
export const ROLE_LABELS: Readonly<Record<DocumentRole, string>> = {
  owner: '所有者',
  editor: '编辑者',
  commenter: '评论者',
  viewer: '只读查看者',
};

/** 一个已知角色的中文标签。 */
export function roleLabel(role: DocumentRole): string {
  return ROLE_LABELS[role];
}
