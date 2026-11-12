"use client";

import Link from "next/link";
import { useMe, useMenus } from "@/lib/useMeta";
import { buildMobileHomeCards } from "@/lib/mobilePwaNav";
import { useMobileShell } from "@/components/shell/MobileShellContext";
import s from "./MobileHome.module.css";

/**
 * 手机工作台首页（≤767px，按已确认草稿 docs/prototypes/mobile-pwa）。
 *
 * 只展示身份与入口：问候语取真实 userName；四张入口卡和两条 quick row
 * 全部按当前权限投影（`navItems`）过滤，不展示任何编造的业务数字。
 * 桌面仍渲染 WelcomeTunnel（由 dashboard/page.tsx 按 useIsMobile 切换）。
 */
export default function MobileHome() {
  const { displayName } = useMe();
  const { ready, loading } = useMenus();
  const { navItems, openMore } = useMobileShell();

  const cards = buildMobileHomeCards(navItems);
  // 权限菜单还在路上时只显示四张骨架卡，避免把「云电竞平台」这类
  // 恰好先到的入口排成 09/10 号卡；权限确认后按真实权限渲染前四张。
  const waiting = !ready && (loading || navItems.length <= 3);
  const shownCards = waiting ? [] : cards;
  const skeletonCount = waiting ? 4 : 0;
  const hasContacts = navItems.some((item) => item.href === "/contacts");
  const hasProjects = navItems.some((item) => item.href === "/projects");

  return (
    <div className={s.root} data-mobile-home="true">
      <h1 className={s.hello}>
        你好{displayName ? `，${displayName}` : ""}
        <span>项目、进度、支出与审批。</span>
      </h1>

      <div className={s.grid} aria-label="常用入口">
        {shownCards.map((card) => (
          <Link key={card.href} href={card.href} className={s.card} data-mobile-entry={card.href}>
            <div className={s.cardTop}>
              <span>{card.index}</span>
              <i aria-hidden="true" />
            </div>
            <div>
              <h2>{card.title}</h2>
              <p>{card.note}</p>
            </div>
          </Link>
        ))}
        {skeletonCount > 0
          ? Array.from({ length: skeletonCount }, (_, index) => (
              <div key={index} className={s.cardSkeleton} aria-hidden="true" />
            ))
          : null}
      </div>

      <div className={s.sectionHead}>
        <h2>更多</h2>
        <button type="button" onClick={openMore}>全部入口 →</button>
      </div>

      {hasContacts ? (
        <Link href="/contacts" className={s.moreRow}>
          <span>
            <b>通讯录</b>
            <small>项目成员与外部联系人</small>
          </span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </Link>
      ) : null}

      {hasProjects ? (
        <Link href="/projects" className={`${s.moreRow} ${s.quickRow}`}>
          <span>
            <b>新建项目</b>
            <small>从一张台账开始</small>
          </span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </Link>
      ) : null}

    </div>
  );
}
