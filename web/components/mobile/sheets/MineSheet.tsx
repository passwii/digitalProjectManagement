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
// 默认档位 half（§3 表格）：由 `SHEET_DEFAULT_STOP` 控制，本文件不管档位。

import { useRouter } from "next/navigation";
import { approvalsApi, authApi, clearSession } from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { clearMetaCache, useMe, useMeta } from "@/lib/useMeta";
import { SPARK_WINDOW_TARGET } from "@/lib/spark/navigation";
import Avatar from "@/components/ui/Avatar";
import SheetCard from "../SheetCard";
import type { SheetContentProps } from "./index";
import s from "./sheets.module.css";

export default function MineSheet({
  variant,
  onSelect,
  item,
  ready,
  failed,
  canApprove,
  onReloadMenus,
}: SheetContentProps) {
  const router = useRouter();
  const { me, displayName, roleNames } = useMe();
  const { deptName } = useMeta();

  // 管理员才需要待审批总数；非管理员 / 权限未确认时不发这个请求
  const showAdmin = ready && !failed && canApprove && item.visible.length > 0;
  const { data: pending } = useAsyncData((signal) => approvalsApi.pending(signal), [], {
    enabled: showAdmin,
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
    ? canApprove
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
          <span className={s.rolePill} data-admin={canApprove}>
            {canApprove ? "管理员" : "成员"}
          </span>
        )}
      </div>

      {showAdmin ? (
        <>
          <div className={s.sec}>管理与审批</div>
          {item.visible.map((m) => (
            <SheetCard
              key={m.href}
              variant={variant}
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

      <div className={s.sec}>通用入口</div>
      <SheetCard
        variant={variant}
        href="/spark"
        target={SPARK_WINDOW_TARGET}
        title="Spark 演示站"
        note="NebulaCloud 演示站"
        onSelect={onSelect}
      />

      <div className={s.sec}>账号</div>
      <SheetCard
        variant={variant}
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
