import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 手机端入口契约（BLF-1389）。
 *
 * 守两件事：
 *   1. 「我的」面板里两个独立站点的入口都在（之前只有 `/spark` 一张卡）；
 *   2. **手机端不用 `target`** —— 手机上 `target` 会开出一堆新标签页；
 *      桌面端侧栏仍保留 `target`（两个站点各有自己的浏览上下文）。
 *
 * 这两条都是「看代码就能确定」的性质：入口清单与 `target` 有没有，
 * 都在源码里。真机走查能发现「手机上跳出了新标签」，但守不住 ——
 * 改回 `target` 不会有任何测试变红。
 */

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8");
}

const mineSheet = read("components/mobile/sheets/MineSheet.tsx");
const desktopLayout = read("app/(dashboard)/layout.tsx");

describe("手机端入口：两个独立站点都在（BLF-1389）", () => {
  it("「我的」面板有云电竞管理平台与智能音视频平台两张卡", () => {
    expect(mineSheet).toMatch(/href="\/spark"[\s\S]*?title="云电竞管理平台"/);
    expect(mineSheet).toMatch(/href="\/stream-monitor"[\s\S]*?title="智能音视频平台"/);
  });

  it("入口路径是改名后的 /stream-monitor（BLF-1387 口径）", () => {
    expect(mineSheet).toMatch(/href="\/stream-monitor"/);
    expect(mineSheet).not.toMatch(/href="\/av"/);
  });

  it("手机端入口不带 target（同页导航，不开新标签页）", () => {
    // `target` 在手机上会开新标签页：屏幕底部多一条地址栏，
    // 回主工作台要连点好几次「返回」，standalone 下用户更无从察觉。
    expect(mineSheet).not.toMatch(/target=\{SPARK_WINDOW_TARGET\}/);
    expect(mineSheet).not.toMatch(/target=\{AV_WINDOW_TARGET\}/);
    // 整个手机端入口文件里都不该再有 target 透传。
    expect(mineSheet).not.toMatch(/\btarget=/);
  });

  it("桌面端侧栏仍保留 target（两个站点各自的浏览上下文）", () => {
    expect(desktopLayout).toMatch(/SPARK_WINDOW_TARGET/);
    expect(desktopLayout).toMatch(/AV_WINDOW_TARGET/);
  });

  it("桌面端在手机形态下自动去掉 target（断点跟随）", () => {
    // 侧栏在 ≤767px 是 display:none（手机外壳是底部 Dock），
    // 但断点切换时 DOM 还在 —— target 必须跟着断点走。
    expect(desktopLayout).toMatch(/useIsMobile/);
    expect(desktopLayout).toMatch(/isMobile\s*\?\s*undefined/);
  });
});

describe("手机端入口：站点身份模块是唯一真源（BLF-1389）", () => {
  it("安装提示按当前站点取名字（不在站点上提示「安装数科云办公」）", () => {
    const installPrompt = read("components/pwa/InstallPrompt.tsx");
    expect(installPrompt).toMatch(/siteIdentityFor/);
    // 文案里不能再写死「安装数科云办公」。
    // 只看**用户可见的文案**（去掉注释再扫）：注释里可以引用旧文案来解释
    // 「以前这里是写死的」，那是维护者看的知识，不是产品文案。
    //
    // ⚠️ 去行注释时只认「行首（允许缩进）的 //」：用 `/\/\/[^\n]*/g` 这种粗正则
    // 会把**字符串里**的 `//` 也当成行注释起点，把后面的真实文案吃掉 ——
    // 那样断言就成了永远绿的空跑。
    const visible = installPrompt
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/[^\n]*/gm, "");
    expect(visible).not.toMatch(/安装数科云办公/);
    expect(visible).not.toMatch(/将数科云办公安装到手机/);
    // 但主工作台的名字由站点身份模块提供。
    // 注意 JSX 里的插值是 `{site.name}`（不是模板串的 `${site.name}`）。
    expect(visible).toMatch(/安装\{site\.name\}/);
    expect(visible).toMatch(/将\{site\.name\}安装到手机/);
  });

  it("站点身份模块收敛了三个站点的名字 / manifest / 主题色", () => {
    const identity = read("lib/siteIdentity.ts");
    expect(identity).toMatch(/name:\s*"数科云办公"/);
    expect(identity).toMatch(/name:\s*"云电竞管理平台"/);
    expect(identity).toMatch(/name:\s*"智能音视频平台"/);
    expect(identity).toMatch(/manifest:\s*"\/manifest\.webmanifest"/);
    expect(identity).toMatch(/manifest:\s*"\/spark\/manifest\.webmanifest"/);
    expect(identity).toMatch(/manifest:\s*"\/stream-monitor\/manifest\.webmanifest"/);
  });

  it("站点身份模块不出现英文品牌（BLF-1397 口径）", () => {
    const identity = read("lib/siteIdentity.ts");
    expect(identity).not.toMatch(/"Stream Monitor"|"STREAM MONITOR"/);
  });
});
