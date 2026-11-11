import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 手机 PWA 外壳的源码契约（≤767px）。
 *
 * 这些性质（安全区、100dvh、触控 44px、内容不被 dock 遮挡、横屏可滚）
 * 一旦回退不会报错，只会在真机上悄悄变形，所以用 CI 守住。
 */

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8");
}

const layout = read("app/(dashboard)/layout.tsx");
const shellCss = read("components/shell/MobilePwaShell.module.css");
const dockCss = read("components/shell/MobileBottomDock.module.css");
const sheetCss = read("components/shell/MobileMoreSheet.module.css");
const homeCss = read("components/dashboard/MobileHome.module.css");

describe("手机 PWA 外壳结构", () => {
  it("桌面药丸保持不变，手机壳接入同一份 navItems", () => {
    expect(layout).toContain("CenteredNavbar");
    expect(layout).toContain("MobileBrandBar");
    expect(layout).toContain("<MobileBottomDock");
    expect(layout).toContain("<MobileMoreSheet");
    expect(layout).toContain("items={navItems}");
    expect(layout).toContain("splitNav(navItems, pathname).overflow");
  });

  it("≤767px 隐藏顶部药丸占位，且不删除 data-console-shell", () => {
    expect(shellCss).toMatch(/@media \(max-width: 767px\)/);
    expect(shellCss).toMatch(/\.navDockSlot,[\s\S]*?\.brandFloatSlot\s*\{\s*display:\s*none;/);
    expect(layout).toContain('data-console-shell="true"');
  });

  it("横屏手机也归入手机壳（CSS 视口宽度是长边，不能只认 767px）", () => {
    const landscape = /\(max-width: 932px\) and \(max-height: 500px\) and \(orientation: landscape\)/;
    expect(shellCss).toMatch(landscape);
    expect(dockCss).toMatch(landscape);
    expect(homeCss).toMatch(landscape);
    const viewport = read("lib/mobilePwaViewport.ts");
    expect(viewport).toContain("max-width: 932px");
    expect(viewport).toContain("orientation: landscape");
    const page = read("app/(dashboard)/dashboard/page.tsx");
    expect(page).toContain("useMobilePwaViewport");
  });

  it("横屏手机也使用移动视口决定 target，不把独立站点开成新标签", () => {
    expect(layout).toContain("useMobilePwaViewport");
    expect(layout).toMatch(/target:\s*mobileViewport\s*\?/);
    expect(layout).not.toContain("target: isMobile ?");
  });

  it("100dvh + 工作台内容区内部滚动（横屏短屏不裁切）", () => {
    expect(shellCss).toMatch(/min-height:\s*100vh;/);
    expect(shellCss).toMatch(/min-height:\s*100dvh;/);
    expect(shellCss).toMatch(/height:\s*100dvh;/);
    expect(shellCss).toMatch(/\.shell\[data-dashboard-shell="true"\] \.content\s*\{[^}]*overflow-y:\s*auto/);
  });

  it("内容底部为 dock + 安全区让位", () => {
    expect(shellCss).toMatch(
      /padding-bottom:\s*calc\(62px \+ 8px \+ env\(safe-area-inset-bottom, 0px\) \+ 24px\)/,
    );
    expect(homeCss).toMatch(/padding:[\s\S]*env\(safe-area-inset-bottom, 0px\)/);
  });
});

describe("手机底部 dock", () => {
  it("固定贴底，并为 home indicator 留出安全区", () => {
    expect(dockCss).toMatch(/position:\s*fixed/);
    expect(dockCss).toMatch(/bottom:\s*calc\(8px \+ env\(safe-area-inset-bottom, 0px\)\)/);
    expect(dockCss).toMatch(/height:\s*62px/);
  });

  it("每个槽位 ≥44px 触控目标，且有可见键盘焦点", () => {
    expect(dockCss).toMatch(/\.tab\s*\{[^}]*min-height:\s*var\(--m-tap\)/);
    expect(dockCss).toMatch(/focus-visible/);
    expect(dockCss).toMatch(/touch-action:\s*manipulation/);
  });

  it("当前项液态胶囊可见，reduced-motion 下关闭过渡", () => {
    expect(dockCss).toMatch(/\.liquid\[data-visible="true"\]\s*\{\s*opacity:\s*1/);
    expect(dockCss).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.liquid[\s\S]*transition:\s*none/);
  });

  it("不写裸色值（颜色全部来自语义令牌）", () => {
    expect(dockCss).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(dockCss).not.toMatch(/rgba?\(/);
  });
});

describe("更多 sheet 与移动首页", () => {
  it("sheet 底部圆角、可滚动、吃底部安全区", () => {
    expect(sheetCss).toMatch(/max-height:\s*72dvh/);
    expect(sheetCss).toMatch(/overflow-y:\s*auto/);
    expect(sheetCss).toMatch(/overscroll-behavior:\s*contain/);
    expect(sheetCss).toMatch(/env\(safe-area-inset-bottom, 0px\)/);
  });

  it("sheet 的关闭/账号动作 ≥44px，且 reduced-motion 关闭过渡", () => {
    expect(sheetCss).toMatch(/\.close\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/);
    expect(sheetCss).toMatch(/\.accountLink,\s*\.logout\s*\{[^}]*min-height:\s*var\(--m-tap\)/);
    expect(sheetCss).toMatch(/prefers-reduced-motion: reduce[\s\S]*transition:\s*none/);
  });

  it("移动首页只在 ≤767px 出现，问候和入口卡按真实权限数据渲染", () => {
    expect(homeCss).toMatch(/\.root\s*\{\s*display:\s*none/);
    expect(homeCss).toMatch(/@media \(max-width: 767px\)/);
    expect(read("components/dashboard/MobileHome.tsx")).toContain("buildMobileHomeCards(navItems)");
  });
});
