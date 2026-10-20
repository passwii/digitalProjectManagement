import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AV_BREATH_SECONDS,
  AV_EASE,
  AV_MOTION,
  AV_MOTION_ATTRIBUTE,
  AV_MOTION_BOOTSTRAP_SCRIPT,
  AV_MOTION_CSS_VARIABLES,
  AV_SHIMMER_SECONDS,
  AV_STAGGER,
  avDurationMs,
  avDurationSeconds,
  avItemMotion,
  avStaggerSeconds,
  formatCountValue,
  isMotionEnabled,
  parseCountValue,
  parseStaticMode,
} from "@/lib/av/motion";

/**
 * Stage 3 动效令牌契约（BLF-1375）。
 *
 * 这里守的是「动效不许各写各的」这件事：
 *   · 四档时长与三条曲线的取值、顺序、上限；
 *   · TS ↔ CSS 的数值必须逐条相等（module.css 读的是同一组变量）；
 *   · `?static=1` / prefers-reduced-motion 下时长真的归零；
 *   · 全站不允许出现绕过令牌的裸时长（源码扫描）。
 *
 * 之所以放在 vitest（`npm run test:motion`）而不是 node:test：
 * 这一套里有「读 CSS 源文件 + 正则扫描源码」的守卫，vitest 的 expect 报错信息
 * 能把违规文件名与片段直接打出来（见 avSourceGuard 的先例）。
 */

function globalsCss(): string {
  return readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
}

describe("动效令牌：四档时长 + 三条曲线", () => {
  it("四档时长严格递增，且最长不超过 0.5s", () => {
    expect(AV_MOTION.instant).toBeLessThan(AV_MOTION.quick);
    expect(AV_MOTION.quick).toBeLessThan(AV_MOTION.base);
    expect(AV_MOTION.base).toBeLessThan(AV_MOTION.slow);
    // §五 反面清单：超过 0.5s 的入场动画会被等得不耐烦
    expect(AV_MOTION.slow).toBeLessThanOrEqual(0.5);
  });

  it("三条曲线都是合法的 cubic-bezier（x 在 0..1，共 4 个数）", () => {
    for (const [name, curve] of Object.entries(AV_EASE)) {
      expect(curve, name).toHaveLength(4);
      for (const value of curve) expect(Number.isFinite(value), name).toBe(true);
      expect(curve[0], `${name} x1`).toBeGreaterThanOrEqual(0);
      expect(curve[0], `${name} x1`).toBeLessThanOrEqual(1);
      expect(curve[2], `${name} x2`).toBeGreaterThanOrEqual(0);
      expect(curve[2], `${name} x2`).toBeLessThanOrEqual(1);
    }
    // 与既有 --ease-console 同值（Stage 3 要求复用而不是新造一条同名曲线）
    expect(AV_EASE.standard).toEqual([0.2, 0.72, 0.2, 1]);
  });

  it("错峰：前 10 项递增，第 11 项起不再延迟，长列表整段关闭", () => {
    expect(avStaggerSeconds(0, 50)).toBe(0);
    expect(avStaggerSeconds(1, 50)).toBeCloseTo(AV_STAGGER.list, 6);
    expect(avStaggerSeconds(9, 50)).toBeCloseTo(AV_STAGGER.list * 9, 6);
    // 第 10 项（第 11 条）不再延迟 —— 50 条全错峰会让最后一条等 1.5s
    expect(avStaggerSeconds(10, 50)).toBe(0);
    expect(avStaggerSeconds(99, 50)).toBe(0);
    // > 100 行的长列表不做入场错峰（§三 性能硬约束）
    expect(avStaggerSeconds(3, AV_STAGGER.longList + 1)).toBe(0);
    // 时间线用更宽的步长
    expect(avStaggerSeconds(2, 10, AV_STAGGER.timeline)).toBeCloseTo(AV_STAGGER.timeline * 2, 6);
  });

  it("退场比入场快：关闭/离开走 quick，打开/进入走 base", () => {
    // 这是「为什么退场比入场快」的可执行版本，改坏了会在 CI 里红
    const enterExit = { open: AV_MOTION.base, close: AV_MOTION.quick };
    expect(enterExit.close).toBeLessThan(enterExit.open);
    // hover-in（quick）比 hover-out（instant）慢
    expect(AV_MOTION.instant).toBeLessThan(AV_MOTION.quick);
  });
});

describe("TS ↔ CSS 数值契约", () => {
  it("globals.css 里每一个 --av-dur-* / --av-ease-* 都与 motion.ts 相等", () => {
    const css = globalsCss();
    for (const [name, value] of Object.entries(AV_MOTION_CSS_VARIABLES)) {
      const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
      expect(match, `globals.css 缺少 ${name}`).not.toBeNull();
      expect(match?.[1].trim(), name).toBe(value);
    }
  });

  it("`?static=1` 与减少动效把每个时长都归零（CSS 侧）", () => {
    const css = globalsCss();
    const offBlock = /:root\[data-av-motion="off"\]\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
    const reducedBlock = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
    for (const name of Object.keys(AV_MOTION_CSS_VARIABLES)) {
      if (!name.startsWith("--av-dur")) continue;
      expect(offBlock, `${name} 未在 static 块归零`).toMatch(new RegExp(`${name}:\\s*0ms`));
      expect(reducedBlock, `${name} 未在 reduced 块归零`).toMatch(new RegExp(`${name}:\\s*0ms`));
    }
    // 归零的同时还要真的把 transition / animation 停掉，否则 JS 驱动的动画仍在跑
    expect(css).toMatch(/:root\[data-av-motion="off"\] \*[\s\S]{0,200}animation:\s*none\s*!important/);
  });

  it("骨架屏与呼吸的长来自令牌，不是散落的字面量", () => {
    expect(AV_MOTION_CSS_VARIABLES["--av-dur-breathe"]).toBe(`${AV_BREATH_SECONDS * 1000}ms`);
    expect(AV_MOTION_CSS_VARIABLES["--av-dur-shimmer"]).toBe(`${AV_SHIMMER_SECONDS * 1000}ms`);
  });
});

describe("降级：?static=1 与 prefers-reduced-motion", () => {
  it("parseStaticMode 只认 static，不误伤其它参数", () => {
    expect(parseStaticMode("?static=1")).toBe(true);
    expect(parseStaticMode("static")).toBe(true);
    expect(parseStaticMode("?static")).toBe(true);
    expect(parseStaticMode("?static=true")).toBe(true);
    expect(parseStaticMode("?static=0")).toBe(false);
    expect(parseStaticMode("?static=false")).toBe(false);
    expect(parseStaticMode("?q=static=1")).toBe(false);
    expect(parseStaticMode("")).toBe(false);
  });

  it("首帧脚本在 static=1 时把 <html> 置为 off，否则置 on", () => {
    expect(AV_MOTION_BOOTSTRAP_SCRIPT).toContain(`setAttribute("${AV_MOTION_ATTRIBUTE}",frozen?"off":"on")`);
    expect(AV_MOTION_BOOTSTRAP_SCRIPT).toContain('get("static")');
  });

  it("降级状态下所有时长都返回 0（JS 侧，不需要调用方再写 if）", () => {
    for (const state of [{ reduced: true, frozen: false }, { reduced: false, frozen: true }, { reduced: true, frozen: true }]) {
      expect(isMotionEnabled(state)).toBe(false);
      expect(avDurationSeconds("base", state)).toBe(0);
      expect(avDurationMs("slow", state)).toBe(0);
    }
    expect(avDurationMs("slow", { reduced: false, frozen: false })).toBe(AV_MOTION.slow * 1000);
  });

  it("降级时不产生 initial 位移（截图与静态页必须完全一致）", () => {
    const motion = avItemMotion(3, 20, { reduced: true, frozen: false });
    expect(motion.initial).toBe(false);
    expect(motion.transition.duration).toBe(0);
    expect(motion.transition.delay).toBe(0);
    // 正常态：位移只有 6px，且以 opacity + transform 表达
    const normal = avItemMotion(3, 20);
    expect(normal.initial).toEqual({ opacity: 0, y: 6 });
    expect(Object.keys(normal.animate).sort()).toEqual(["opacity", "y"]);
  });
});

describe("KPI 数字滚动：解析与还原", () => {
  it("千分位整数原样滚回（宽度不抖的前提是逐字还原）", () => {
    const spec = parseCountValue("14,366");
    expect(spec).toEqual({ prefix: "", value: 14366, decimals: 0, grouped: true, suffix: "" });
    expect(formatCountValue(14366, spec!)).toBe("14,366");
    expect(formatCountValue(0, spec!)).toBe("0");
  });

  it("小数位按原串保留（99.8 → 滚到 99.8，不会变成 99.80）", () => {
    const spec = parseCountValue("99.8")!;
    expect(spec.value).toBe(99.8);
    expect(spec.decimals).toBe(1);
    expect(formatCountValue(99.8, spec)).toBe("99.8");
  });

  it("前后缀原样保留；非数字串返回 null（绝不把「—」滚成 0）", () => {
    const spec = parseCountValue("¥1,200 起")!;
    expect(spec.prefix).toBe("¥");
    expect(spec.value).toBe(1200);
    expect(spec.suffix).toBe(" 起");
    expect(parseCountValue("—")).toBeNull();
    expect(parseCountValue("无数据")).toBeNull();
  });
});

describe("源码守卫：不允许绕过令牌的裸时长", () => {
  const files = [
    "components/av/motion/AvMotion.module.css",
    "components/av/pages/AvPages.module.css",
    "components/av/AvUI.module.css",
    "components/av/AvShell.module.css",
    "components/av/AvCharts.module.css",
  ];

  it("智能音视频平台的 CSS 模块里没有裸的毫秒 / 秒时长（只能写 var(--av-dur-*)）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      // 只扫 transition / animation 声明里的时长；像素、行高、字号不在其列
      const declarations = source.match(/(?:transition|animation)[^;{}]*:[^;{}]*;/g) ?? [];
      for (const declaration of declarations) {
        const stripped = declaration.replace(/var\(--[\w-]+\)/g, "").replace(/calc\([^)]*\)/g, "");
        if (/(^|[^\d.])\d*\.?\d+m?s\b/.test(stripped)) {
          offenders.push(`${file}: ${declaration.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("智能音视频平台的组件里没有手写的 transition duration 字面量", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) {
          const source = readFileSync(resolve(process.cwd(), path), "utf8");
          // duration: 0.24 / animationDuration: 240 这类都算硬编码（0 是允许的降级值）
          // 冒号前**不允许**空格：三元表达式 `duration > 0 ? duration : 1` 里也有
          // 「duration : 1」这种形态，宽松匹配会把合法的 rAF 兜底值报成违规。
          const matches = Array.from(source.matchAll(/(?:duration|animationDuration|staggerChildren|delayChildren):\s*([0-9.]+)/g));
          for (const match of matches) {
            if (Number(match[1]) !== 0) offenders.push(`${path}: ${match[0]}`);
          }
        }
      }
    };
    walk("components/av");
    expect(offenders).toEqual([]);
  });

  it("关键帧只动 transform / opacity（不触发 layout）", () => {
    const css = globalsCss();
    const block = css.slice(css.indexOf("@keyframes avPageIn"));
    const keyframes = block.match(/@keyframes av[\s\S]*?(?=\n@|\n\/\*|\n:root|$)/g) ?? [];
    expect(keyframes.length).toBeGreaterThan(4);
    const forbidden = /(?:^|[\s;{])(?:width|height|top|left|right|bottom|margin|padding|font-size)\s*:/;
    for (const frame of keyframes) {
      const body = frame.replace(/@keyframes[^{]+\{/, "");
      expect(body, frame.slice(0, 40)).not.toMatch(forbidden);
    }
  });
});
