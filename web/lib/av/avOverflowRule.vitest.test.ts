import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OVERFLOW_TOLERANCE_PX, classifyCardBox } from "../../../scripts/lib/avOverflowRule.mjs";

/**
 * 智能音视频平台 卡片溢出判定的行为级守卫（Stage 6 / BLF-1399 复审补丁）。
 *
 * ## 为什么要有这一份
 *
 * `scripts/av-layout-overflow.mjs` 是排版标定的**实测**手段（issue 风险 #1：
 * 等高策略会不会让内容溢出卡片）。复审指出它**看不见「没被裁的溢出」**：
 *
 *   旧判定 = `delta > 1 && overflow ∈ {hidden, clip, auto, scroll}`。
 *
 * 而站点那六个卡片族（`.panel` / `.metric` / `.channel` / `.sceneCard` /
 * `.statusCell` / `.algoCard`）在两份受管 CSS 里**一条 `overflow` 都没设**
 * —— 默认就是 `visible`。于是旧判定的后半截条件**永远不成立**：
 * 内容真的溢出盒子时，脚本判不出来。
 *
 * 实测（复审的故障注入）：把 `.metric` 强压成 `height: 44px`（不写 overflow），
 * 内容向下**可见溢出 83px**，旧脚本**退出码 0「验收通过」**。
 *
 * 换句话说：不是脚本的阈值太松，而是它**有一半是死的**。
 * BLF-1389 的移动端工作会直接复用这个脚本，窄屏正是溢出高发区 ——
 * 拿一盏可能常亮的绿灯当门禁，比没有门禁更危险。
 *
 * ## 这里守什么
 *
 * 判定口径被提到 `scripts/lib/avOverflowRule.mjs`（脚本与守卫共用同一份），
 * 本守卫对它做**行为级**断言：
 *
 *   1. **不看 overflow 计算值**：正向 delta 超容差即记溢出，
 *      无论 `overflow` 是 `visible` / `hidden` / `auto` / `scroll`；
 *   2. **容差**：≤ 1px 的差值不算溢出（`scrollHeight` 是取整值，
 *      子像素布局下会出现 1px 假差）；
 *   3. **两轴独立**：纵向与横向各判各的，不能互相带出；
 *   4. **脚本与守卫同源**：脚本必须真的用这个模块的函数，
 *      而不是自己抄一份判定（抄的那份会漂移），
 *      并且脚本源码里不许再出现旧的 `["hidden","clip","auto","scroll"]` 门槛。
 *
 * 第 4 条是这份守卫真正的价值：它保证**脚本用的就是被断言的那份代码**。
 * 这份守卫自己也要经得起故障注入（见文件末尾「反向验证」一节）。
 */

/** 判定函数所在的模块（脚本与守卫共用）。 */
const RULE_MODULE = resolve(process.cwd(), "../scripts/lib/avOverflowRule.mjs");

/** 走查脚本本身。 */
const SCRIPT = resolve(process.cwd(), "../scripts/av-layout-overflow.mjs");

/** 站点受管的两个 CSS（用于核对「卡片族确实没设 overflow」这个前提）。 */
const MANAGED_CSS = [
  "components/av/AvUI.module.css",
  "components/av/pages/AvPages.module.css",
] as const;

/** 六个卡片族（与走查脚本的 cardSelectors 同源）。 */
const CARD_FAMILIES = [
  ".panel",
  ".metric",
  ".channel",
  ".sceneCard",
  ".statusCell",
  ".algoCard",
] as const;

/** 造一个盒子：给出 scroll/client 四元组与 overflow 计算值。 */
function box(options: {
  scrollHeight: number;
  clientHeight: number;
  scrollWidth?: number;
  clientWidth?: number;
  overflowY?: string;
  overflowX?: string;
}) {
  return {
    scrollHeight: options.scrollHeight,
    clientHeight: options.clientHeight,
    scrollWidth: options.scrollWidth ?? 100,
    clientWidth: options.clientWidth ?? 100,
    overflowY: options.overflowY ?? "visible",
    overflowX: options.overflowX ?? "visible",
  };
}

describe("智能音视频平台 卡片溢出判定：正向 delta 即记溢出（BLF-1399）", () => {
  it("overflow: visible 的盒子内容超出时**必须**记溢出（旧判定的盲区）", () => {
    // 复审的故障注入原样：内容 126px、盒子 42px，overflow 是默认的 visible。
    const verdict = classifyCardBox(
      box({ scrollHeight: 126, clientHeight: 42, overflowY: "visible" }),
      OVERFLOW_TOLERANCE_PX,
    );
    expect(verdict.overflow).toBe(true);
    expect(verdict.overflowedY).toBe(true);
    expect(verdict.overflowY).toBe(84);
  });

  it("overflow 是 hidden / clip / auto / scroll 时同样记溢出（口径与 overflow 无关）", () => {
    // 旧判定只在这四种值下才算数；现在四种都算，且 visible 也算。
    for (const overflowY of ["hidden", "clip", "auto", "scroll", "visible"]) {
      const verdict = classifyCardBox(
        box({ scrollHeight: 126, clientHeight: 42, overflowY }),
        OVERFLOW_TOLERANCE_PX,
      );
      expect(verdict.overflow, `overflowY=${overflowY} 应当记溢出`).toBe(true);
    }
  });

  it("溢出只影响报告措辞，不影响「算不算溢出」", () => {
    const spilled = classifyCardBox(
      box({ scrollHeight: 126, clientHeight: 42, overflowY: "visible" }),
      OVERFLOW_TOLERANCE_PX,
    );
    const clipped = classifyCardBox(
      box({ scrollHeight: 126, clientHeight: 42, overflowY: "hidden" }),
      OVERFLOW_TOLERANCE_PX,
    );
    expect(spilled.overflow).toBe(clipped.overflow);
    expect(spilled.axisY).toBe("spilled");
    expect(clipped.axisY).toBe("clipped");
  });

  it("容差之内不算溢出（scrollHeight 取整造成的 1px 假差不算）", () => {
    const verdict = classifyCardBox(
      box({ scrollHeight: 43, clientHeight: 42 }),
      OVERFLOW_TOLERANCE_PX,
    );
    expect(verdict.overflow).toBe(false);
    expect(verdict.axisY).toBe("ok");
  });

  it("恰好等于容差也不算溢出，超过 1px 才算", () => {
    expect(
      classifyCardBox(box({ scrollHeight: 43, clientHeight: 42 }), OVERFLOW_TOLERANCE_PX).overflow,
    ).toBe(false);
    expect(
      classifyCardBox(box({ scrollHeight: 44, clientHeight: 42 }), OVERFLOW_TOLERANCE_PX).overflow,
    ).toBe(true);
  });

  it("内容没超出盒子时不算溢出", () => {
    const verdict = classifyCardBox(
      box({ scrollHeight: 42, clientHeight: 42 }),
      OVERFLOW_TOLERANCE_PX,
    );
    expect(verdict.overflow).toBe(false);
    expect(verdict.overflowedY).toBe(false);
    expect(verdict.overflowedX).toBe(false);
  });

  it("两轴独立：横向溢出不能带出纵向，纵向溢出不能带出横向", () => {
    const horizontal = classifyCardBox(
      box({ scrollHeight: 100, clientHeight: 100, scrollWidth: 180, clientWidth: 100 }),
      OVERFLOW_TOLERANCE_PX,
    );
    expect(horizontal.overflow).toBe(true);
    expect(horizontal.overflowedX).toBe(true);
    expect(horizontal.overflowedY).toBe(false);
    expect(horizontal.axisY).toBe("ok");

    const vertical = classifyCardBox(
      box({ scrollHeight: 180, clientHeight: 100, scrollWidth: 100, clientWidth: 100 }),
      OVERFLOW_TOLERANCE_PX,
    );
    expect(vertical.overflow).toBe(true);
    expect(vertical.overflowedY).toBe(true);
    expect(vertical.overflowedX).toBe(false);
    expect(vertical.axisX).toBe("ok");
  });
});

describe("智能音视频平台 溢出判定：脚本与守卫同源（BLF-1399）", () => {
  it("走查脚本 import 并使用共享判定模块", () => {
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).toContain('from "./lib/avOverflowRule.mjs"');
    // 判定函数是**嵌进浏览器探针**跑的，所以脚本必须用 toString() 带进去。
    expect(source).toContain("classifyCardBox.toString()");
  });

  it("走查脚本不再保留旧的 overflow 门槛（那正是盲区的成因）", () => {
    const source = readFileSync(SCRIPT, "utf8");
    // 旧判定的形态：要求 overflow 计算值落在裁剪/滚动集合里才算数。
    expect(source).not.toMatch(/\["hidden"\s*,\s*"clip"\s*,\s*"auto"\s*,\s*"scroll"\]/);
    // 「clipping / scrolling」这两个集合现在只活在共享模块里（用来描述措辞）。
    expect(readFileSync(RULE_MODULE, "utf8")).toContain('["hidden", "clip"]');
  });

  it("共享判定模块是自包含的（函数源码会被嵌进浏览器，不能引用模块作用域）", () => {
    // classifyCardBox 会被 toString() 后原样嵌进浏览器上下文，
    // 所以它内部不许出现「模块作用域里的标识符」。
    const source = classifyCardBox.toString();
    // 允许出现的：参数名、函数体内自己声明的局部变量、字面量。
    // 不允许出现的：OVERFLOW_TOLERANCE_PX 这类模块级常量。
    expect(source).not.toContain("OVERFLOW_TOLERANCE_PX");
    // 函数体里必须自己带上裁剪/滚动两个集合（否则浏览器里是 undefined）。
    expect(source).toContain('["hidden", "clip"]');
    expect(source).toContain('["auto", "scroll"]');
  });
});

describe("智能音视频平台 溢出判定：前提核对（BLF-1399）", () => {
  it("六个卡片族在受管 CSS 里确实没设 overflow —— 这正是旧判定失明的原因", () => {
    // 这条断言守的是**前提**：如果哪天有人给卡片加了 overflow:hidden，
    // 旧判定会「碰巧」重新生效，但新判定本来就不依赖它，两种都对。
    // 反过来，如果前提不成立（卡片开始自己裁内容），需要重新评估
    // 「溢出到盒子外」与「内容被裁」是不是都该算失败。
    const offenders: string[] = [];
    for (const relative of MANAGED_CSS) {
      const css = readFileSync(resolve(process.cwd(), relative), "utf8");
      for (const family of CARD_FAMILIES) {
        // 只看这个族自己的规则（`\n.metric {` 之类），不看后代选择器。
        const pattern = new RegExp(`(?:^|\\n)\\${family}(?:\\s*,|\\s*\\{)`, "g");
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(css)) !== null) {
          const body = css.slice(match.index, css.indexOf("}", match.index));
          if (/overflow\s*:/.test(body)) {
            offenders.push(`${relative}: ${family} 设了 overflow（${body.replace(/\s+/g, " ").slice(0, 80)}）`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
