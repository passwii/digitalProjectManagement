"use client";

import Link from "next/link";
import s from "./MobileBrandBar.module.css";

/**
 * 手机顶栏品牌区：只显示品牌，不承担桌面药丸导航的职责。
 *
 * 与桌面品牌浮标（`Shell.module.css` 的 `.brandFloat`）使用同一套视觉语言，
 * 但固定在左上角；右侧 accountDock 只保留「我的」头像入口（通知在菜单里，
 * 不再单列铃铛）。桌面（>767px）完全隐藏。
 */
export default function MobileBrandBar() {
  return (
    <Link href="/dashboard" className={s.root} aria-label="数科云办公移动首页">
      <span className={s.seal} aria-hidden="true">
        <span className={s.sealWord}>SHZK</span>
        <span className={s.sealBar} />
      </span>
      <span className={s.text}>
        <b>数科云办公</b>
        <span>工作台</span>
      </span>
    </Link>
  );
}
