"use client";

// 我的抽屉：账号卡 + 管理与审批入口（仅管理员）+ 账号操作。
//
// D3 的三条锁死在这里：
//   · 管理与审批入口只渲染 `item.visible` —— 它是 `buildDockItems` 按 `keys`
//     过滤后的 `/meta/me/menus` 子集，非管理员天然为空；本文件不做任何角色判断；
//   · 管理员判定用 `canApprove`（与 Dock 红点同一输入，当前契约下与 `is_admin`
//     同判定），且必须同时满足 `ready && !failed` —— 权限未确认或同步失败时
//     绝不猜测管理员身份（§3.2）；
//   · 权限同步失败走降级：账号卡与账号操作照常渲染（参与性入口保留），
//     管理区换成可重试提示，不出现空白抽屉。
// 面板只有一个固定档位；本文件只管理账号内容与权限入口。

import { useRouter } from "next/navigation";
import { approvalsApi, authApi, clearSession } from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { clearMetaCache, useMe, useMeta } from "@/lib/useMeta";
import Avatar from "@/components/ui/Avatar";
import SheetCard from "../SheetCard";
import type { SheetContentProps } from "./index";
import s from "./sheets.module.css";

export default function MineSheet({
  onSelect,
  item,
  ready,
  failed,
  canApprove,
  isAdmin,
  onReloadMenus,
}: SheetContentProps) {
  const router = useRouter();
  const { me, displayName, roleNames } = useMe();
  const { deptName } = useMeta();

  // 「我的」抽屉有已分配的管理/审批类模块时才展示该分组；未确认/同步失败不渲染
  const showManage = ready && !failed && item.visible.length > 0;
  // 待审批总数只有拥有「审批中心」模块时才需要拉取
  const { data: pending } = useAsyncData((signal) => approvalsApi.pending(signal), [], {
    enabled: showManage && canApprove,
  });

  async function logout() {
    try {
      await authApi.logout();
    } catch {
      // 后端不可用也照常清本地会话（与桌面侧栏的登出同语义）
    }
    clearMetaCache();
    clearSession();
    onSelect();
    router.push("/login");
  }

  const roleText = ready
    ? isAdmin
      ? "管理员"
      : roleNames.join("、") || "成员"
    : "身份确认中…";

  return (
    <>
      <div className={s.account} data-sheet-account="true">
        {displayName ? (
          <Avatar name={displayName} size={44} />
        ) : (
          <span className={`skel ${s.nameSkel}`} aria-hidden="true" />
        )}
        <div className={s.accountMeta}>
          {displayName ? (
            <>
              <div className={s.accountName}>{displayName}</div>
              <div className={s.accountRole}>
                {roleText}
                {me?.dept_id != null ? ` · ${deptName(me.dept_id)}` : ""}
              </div>
            </>
          ) : (
            <>
              <span className={`skel ${s.nameSkel}`} aria-hidden="true" />
              <span className="sr-only">身份加载中</span>
            </>
          )}
        </div>
        {ready && (
          <span className={s.rolePill} data-admin={isAdmin}>
            {isAdmin ? "管理员" : "成员"}
          </span>
        )}
      </div>

      {showManage ? (
        <>
          <div className={s.sec}>功能入口</div>
          {item.visible.map((m) => (
            <SheetCard
              key={m.href}
              href={m.href}
              title={m.label}
              note={
                m.key === "approvals" && pending != null
                  ? `待处理 ${pending.total} 项`
                  : "进入模块"
              }
              onSelect={onSelect}
            />
          ))}
        </>
      ) : (
        failed && (
          <div className={s.retry} role="alert">
            <span>权限信息加载失败，仅显示基础入口。</span>
            {onReloadMenus && (
              <button type="button" onClick={onReloadMenus}>
                重试
              </button>
            )}
          </div>
        )
      )}

      <div className={s.sec}>独立站点</div>
      {/*
        手机端**不**用 `target`（BLF-1389）。
        `target` 会在手机上开出一堆新标签页：用户点「云电竞管理平台」，
        浏览器弹出一个新标签，屏幕底部多一条地址栏，回主工作台还要连点好几次
        「返回」。手机是单任务，入口应该同页导航。
        桌面端侧栏仍保留 `target`（见 `app/(dashboard)/layout.tsx`）——
        那里两个站点各有自己的浏览上下文，桌面用户能同时开两个窗口。
      */}
      <SheetCard
        href="/spark"
        title="云电竞管理平台"
        note="云电竞运营入口"
        onSelect={onSelect}
      />
      <SheetCard
        href="/stream-monitor"
        title="智能音视频平台"
        note="音视频安防运营入口"
        onSelect={onSelect}
      />

      <div className={s.sec}>账号</div>
      <SheetCard
        href="/change-password"
        title="修改密码"
        note="更新登录密码"
        onSelect={onSelect}
      />
      <div className={s.full}>
        <button
          type="button"
          className={`btn-ghost ${s.logoutBtn}`}
          onClick={logout}
        >
          退出登录
        </button>
      </div>
    </>
  );
}
