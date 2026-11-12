import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 全局交互收口的两条源码契约（看代码就能确定，但改一行 CSS / JSX 就会悄悄回退）：
 *
 *   1. 超链接的 hover 反馈只用颜色，不再追加下划线 —— 正文链接 hover 时跳一行
 *      会让密集的工作台列表抖动，用户明确要求去掉；
 *   2. 顶栏不再有独立铃铛 —— 通知入口 / 未读数 / 列表整体并入账号「我的」菜单，
 *      不能再长回第二个并列的通知按钮。
 */

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8");
}

const layout = read("app/(dashboard)/layout.tsx");
const globalsCss = read("app/globals.css");
const avPagesCss = read("components/av/pages/AvPages.module.css");
const notificationCss = read("components/ui/NotificationCenter.module.css");
const shellCss = read("components/ui/Shell.module.css");

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\n${escaped} \\{([^}]*)\\}`).exec(css);
  expect(match, `找不到规则：${selector}`).not.toBeNull();
  return match![1];
}

describe("超链接 hover 只改颜色、不加下划线", () => {
  it("全局 a:hover 与 .linklike:hover 保留信号色反馈", () => {
    const linkHover = ruleBody(globalsCss, "a:hover");
    expect(linkHover).toContain("color: var(--brand-hover)");
    expect(linkHover).not.toContain("underline");

    const linklikeHover = ruleBody(globalsCss, ".linklike:hover");
    expect(linklikeHover).toContain("color: var(--brand-hover)");
    expect(linklikeHover).not.toContain("underline");
  });

  it("AV 文本链接与通知区域的 hover 同样只用颜色", () => {
    const avHover = ruleBody(avPagesCss, ".textLink:hover");
    expect(avHover).toContain("color: var(--av-signal-hover)");
    expect(avHover).not.toContain("underline");
    expect(avPagesCss).toContain("--av-signal-hover");

    expect(ruleBody(notificationCss, ".link:hover")).toContain("color: var(--brand-hover)");
    expect(notificationCss).not.toContain("underline");
  });

  it("受管样式里不再出现 text-decoration: underline", () => {
    for (const file of [
      "app/globals.css",
      "components/av/pages/AvPages.module.css",
      "components/ui/NotificationCenter.module.css",
      "components/ui/Shell.module.css",
    ]) {
      expect(read(file), file).not.toMatch(/text-decoration:\s*underline/);
    }
  });
});

describe("通知入口并入账号「我的」菜单", () => {
  it("布局不再导入 / 渲染独立 Bell，账号区只保留账号浮标", () => {
    expect(layout).not.toMatch(/components\/ui\/Bell/);
    expect(layout).not.toContain("<Bell");
    expect(layout).not.toContain("accountBell");
    expect(layout).toContain("NotificationProvider");
    expect(layout).toContain("<NotificationSection");

    const dock = /<div className=\{`\$\{s\.accountDock\} \$\{pwa\.accountDock\}`\}>([\s\S]*?)<\/div>/.exec(layout)?.[1] ?? "";
    expect(dock, "找不到账号浮标容器").toContain("<UserMenu");
    expect(dock).not.toMatch(/<Bell|accountBell|<NotificationSection/);
  });

  it("独立铃铛的死样式不再残留", () => {
    expect(shellCss).not.toContain(".accountBell");
    expect(shellCss).not.toContain(".brandBell");
  });

  it("手机账号区也有通知入口，且不要求独立铃铛", () => {
    const mobileSheet = read("components/shell/MobileMoreSheet.tsx");
    expect(mobileSheet).toContain("NotificationSection");
    expect(mobileSheet).toContain("data-notification-toggle");
    expect(mobileSheet).not.toMatch(/components\/ui\/Bell/);
  });
});
