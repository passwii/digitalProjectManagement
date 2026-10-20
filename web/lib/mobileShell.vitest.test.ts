import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 移动端壳层契约（BLF-1389）：安全区 / 视口高度 / 触控档 / 页面级无横向溢出。
 *
 * 这几条是**纯 CSS 的性质**，看代码就能确定：安全区用不用
 * `env(safe-area-inset-*)`、视口高度用不用 `100dvh`、窄屏控件有没有抬到
 * 44px。真机走查能发现问题，但**守不住** —— 改一行 CSS 就可能把安全区
 * 弄丢，而且当场看不出来。所以让 CI 守。
 *
 * ⚠️ 刻意**不**重复实现 Stage 6 已经做过的部分：
 *   · `--av-ctl-shell` 的 44px 触控档由 `lib/avControlSizes.vitest.test.ts` 守；
 *   · 间距刻度由 `lib/av/avLayoutTokens.vitest.test.ts` 守。
 * 这里只管 Stage 6 明确留给 BLF-1389 的那部分：安全区与视口高度。
 */

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8");
}

const avShell = read("components/av/AvShell.module.css");
const sparkShell = read("components/spark/SparkShell.module.css");

/** 去掉 CSS 注释后再扫描：注释里写「以前是 100vh」是在解释，不是在使用。 */
function maskComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

describe("智能音视频平台壳层：安全区与视口高度（BLF-1389）", () => {
  it("壳层声明了四个方向的安全区令牌", () => {
    // 令牌名用缩写（--av-safe-t），env() 里用完整方向词（safe-area-inset-top）。
    const sides: Array<[string, string]> = [
      ["t", "top"],
      ["b", "bottom"],
      ["l", "left"],
      ["r", "right"],
    ];
    for (const [token, direction] of sides) {
      expect(
        avShell,
        `AvShell.module.css 缺少 --av-safe-${token}（env(safe-area-inset-${direction})）`,
      ).toMatch(
        new RegExp(`--av-safe-${token}:\\s*env\\(safe-area-inset-${direction},\\s*0px\\)`),
      );
    }
  });

  it("顶栏吃顶部安全区，内容区吃底部安全区", () => {
    const masked = maskComments(avShell);
    // 顶栏：顶部内边距用安全区。
    const topbar = /^\.topbar\s*\{([\s\S]*?)\n\}/m.exec(masked)?.[1] ?? "";
    expect(topbar, "找不到 .topbar 规则").toContain("--av-safe-t");
    // 内容区：底部内边距用安全区（Home 指示条）。
    const content = /^\.content\s*\{([\s\S]*?)\n\}/m.exec(masked)?.[1] ?? "";
    expect(content, "找不到 .content 规则").toContain("--av-safe-b");
  });

  it("左右安全区进了顶栏与内容区的内边距（横屏圆角）", () => {
    const masked = maskComments(avShell);
    for (const selector of ["topbar", "content"]) {
      const body =
        new RegExp(`^\\.${selector}\\s*\\{([\\s\\S]*?)\\n\\}`, "m").exec(masked)?.[1] ?? "";
      expect(body, `.${selector} 没有吃左边安全区`).toContain("--av-safe-l");
      expect(body, `.${selector} 没有吃右边安全区`).toContain("--av-safe-r");
    }
  });

  it("抽屉侧栏吃左右与底部安全区（横屏时刘海那侧会切掉导航项）", () => {
    const masked = maskComments(avShell);
    const sidebar = /^\.sidebar\s*\{([\s\S]*?)\n\}/m.exec(masked)?.[1] ?? "";
    expect(sidebar, "找不到 .sidebar 规则").toContain("--av-safe-l");
    expect(sidebar, "找不到 .sidebar 规则").toContain("--av-safe-r");
    expect(sidebar, "找不到 .sidebar 规则").toContain("--av-safe-b");
  });

  it("视口高度用 100dvh（先 100vh 降级），不再只有 100vh", () => {
    const masked = maskComments(avShell);
    const shell = /^\.shell\s*\{([\s\S]*?)\n\}/m.exec(masked)?.[1] ?? "";
    expect(shell, "找不到 .shell 规则").toMatch(/min-height:\s*100vh;/);
    expect(shell, "找不到 .shell 规则").toMatch(/min-height:\s*100dvh;/);
    // 顺序：100vh 在前（老浏览器用），100dvh 在后（认得的覆盖它）。
    const vh = shell.indexOf("min-height: 100vh;");
    const dvh = shell.indexOf("min-height: 100dvh;");
    expect(vh).toBeGreaterThanOrEqual(0);
    expect(dvh).toBeGreaterThan(vh);
  });

  it("窄屏顶栏的高度把顶部安全区算进去（内边距撑不开固定高度）", () => {
    const masked = maskComments(avShell);
    const phone = /@media \(max-width: 720px\)\s*\{([\s\S]*?)\n\}/.exec(masked)?.[1] ?? "";
    expect(phone, "找不到 ≤720px 段").toContain("--av-safe-t");
  });

  it("抽屉里的导航项在窄屏抬到 44px 触控档", () => {
    const masked = maskComments(avShell);
    const narrow = /@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}/.exec(masked)?.[1] ?? "";
    expect(narrow, "找不到 ≤900px 段").toContain("--av-safe-l");
    const navLink = /^\s*\.navLink\s*\{([\s\S]*?)\n\s*\}/m.exec(narrow)?.[1] ?? "";
    expect(navLink, "≤900px 段没有处理 .navLink").toMatch(/min-height:\s*44px/);
  });

  it("Stage 6 的 44px 触控档没有被本轮改坏（控制器尺寸守卫的同款断言）", () => {
    // 本轮只加了安全区与视口高度，**不能**把 Stage 6 抬上去的触控档改小。
    expect(avShell).toMatch(/@media \(max-width: 900px\)[\s\S]*?--av-ctl-shell:\s*44px;/);
    const globals = read("app/globals.css");
    expect(globals).toMatch(/--av-ctl-shell:\s*34px;/);
  });

  it("表格横向滚动只发生在自身容器内（页面级不产生横向滚动）", () => {
    // 表格容器自带 overflow-x: auto，页面级不横向溢出。
    expect(read("components/av/AvUI.module.css")).toMatch(
      /\.tableWrap\s*\{[^}]*overflow-x:\s*auto/,
    );
    expect(read("components/av/pages/AvPages.module.css")).toMatch(
      /\.tableWrapper\s*\{[^}]*overflow-x:\s*auto/,
    );
    // 手机壳里明确禁止横向溢出。
    expect(maskComments(avShell)).toMatch(/overflow-x:\s*clip/);
  });
});

describe("云电竞管理平台壳层：安全区（BLF-1389）", () => {
  it("顶部、底部、左右四个方向都有安全区", () => {
    const masked = maskComments(sparkShell);
    for (const side of ["top", "bottom", "left", "right"]) {
      expect(
        masked,
        `SparkShell.module.css 缺少 safe-area-inset-${side}`,
      ).toMatch(new RegExp(`env\\(safe-area-inset-${side},\\s*0px\\)`));
    }
  });

  it("左右安全区进了顶栏与内容区（横屏圆角）", () => {
    const masked = maskComments(sparkShell);
    const phone = /@media \(max-width: 767px\)\s*\{([\s\S]*?)\n\}/.exec(masked)?.[1] ?? "";
    expect(phone, "找不到 ≤767px 段").toMatch(/safe-area-inset-left/);
    expect(phone, "找不到 ≤767px 段").toMatch(/safe-area-inset-right/);
  });

  it("视口高度已经是 100dvh（先 100vh 降级）", () => {
    const masked = maskComments(sparkShell);
    const root = /^\.root\s*\{([\s\S]*?)\n\}/m.exec(masked)?.[1] ?? "";
    expect(root).toMatch(/min-height:\s*100vh;/);
    expect(root).toMatch(/min-height:\s*100dvh;/);
  });

  it("窄屏顶栏与内容区都吃底部安全区（Home 指示条）", () => {
    const masked = maskComments(sparkShell);
    expect(masked).toMatch(/safe-area-inset-bottom/);
  });
});
