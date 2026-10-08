import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, mock } from "node:test";
import {
  THEME_MOTION_VARIABLE,
  THEME_SWAP_HOLD_MS,
  THEME_SWAP_MS,
  THEME_TRANSITION_ATTRIBUTE,
  applyTheme,
  prefersReducedMotion,
  readAppliedTheme,
  startThemeSwap,
  themeTransitionValue,
  type ThemeSwapRoot,
} from "./themeTransition";

/**
 * 主题切换过场的纯逻辑与「TS ↔ CSS 契约」守卫（BLF-1292）。
 *
 * DOM 侧的行为（Provider 集成、属性真的落到 <html> 上）在
 * lib/themeProvider.dom.vitest.test.tsx 里跑；这里只覆盖不依赖 DOM 的部分，
 * 好处是能用 node:test 读 CSS 源文件，把两边的数字钉在一起。
 */

interface FakeRoot extends ThemeSwapRoot {
  attributes: Map<string, string>;
  variables: Map<string, string>;
  flushes: () => number;
}

/** 最小结构接口的好处：不用 DOM lib 也能构造一个「够用」的根元素。 */
function fakeRoot(): FakeRoot {
  const attributes = new Map<string, string>();
  const variables = new Map<string, string>();
  let flushes = 0;
  return {
    dataset: {},
    style: {
      colorScheme: "",
      setProperty: (name: string, value: string) => void variables.set(name, value),
      removeProperty: (name: string) => void variables.delete(name),
    },
    get offsetHeight() {
      flushes += 1;
      return 0;
    },
    ownerDocument: null,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
    attributes,
    variables,
    flushes: () => flushes,
  };
}

function globalsCss(): string {
  return readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
}

describe("主题切换过场", () => {
  it("方向值把解析后的主题翻成 CSS 认得的两档", () => {
    assert.equal(themeTransitionValue("dark"), "to-dark");
    assert.equal(themeTransitionValue("light"), "to-light");
  });

  it("读 / 写 <html> 上的主题：非法值读回 null，写入同时落 color-scheme", () => {
    const root = fakeRoot();

    assert.equal(readAppliedTheme(root), null);
    applyTheme(root, "light");
    assert.equal(readAppliedTheme(root), "light");
    assert.equal(root.style.colorScheme, "light");

    root.dataset.theme = "solarized";
    assert.equal(readAppliedTheme(root), null);
  });

  it("减少动效：不挂过场属性、不强制样式计算，但主题必须照落", () => {
    const root = fakeRoot();
    let applied = 0;
    const release = startThemeSwap({
      root,
      direction: "light",
      reduced: true,
      apply: () => {
        applied += 1;
        applyTheme(root, "light");
      },
    });

    assert.equal(applied, 1, "减少动效不能把主题切换本身一起关掉");
    assert.equal(root.attributes.has(THEME_TRANSITION_ATTRIBUTE), false);
    assert.equal(root.variables.has(THEME_MOTION_VARIABLE), false);
    assert.equal(root.flushes(), 0, "不做过场就没必要强制样式计算");
    release();
  });

  it("环境没有 matchMedia 时按「不减少」处理", () => {
    assert.equal(prefersReducedMotion(null), false);
    assert.equal(prefersReducedMotion({}), false);
    assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  });

  it("过场顺序：先挂属性 + 写时长变量并强制样式计算，再落主题", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const root = fakeRoot();
      const seen: string[] = [];

      const release = startThemeSwap({
        root,
        direction: "dark",
        apply: () => {
          seen.push(
            [
              root.attributes.get(THEME_TRANSITION_ATTRIBUTE) ?? "-",
              root.variables.get(THEME_MOTION_VARIABLE) ?? "-",
              root.dataset.theme ?? "-",
            ].join("/"),
          );
          applyTheme(root, "dark");
        },
      });

      assert.deepEqual(
        seen,
        [`to-dark/${THEME_SWAP_MS}ms/-`],
        "apply 必须在属性与时长变量就位、且强制过一次样式计算之后才执行，否则浏览器会跳过过渡（就是原来那个硬切）",
      );
      assert.equal(root.flushes(), 1);
      assert.equal(root.dataset.theme, "dark");

      release();
      assert.equal(root.attributes.has(THEME_TRANSITION_ATTRIBUTE), false);
      assert.equal(root.variables.has(THEME_MOTION_VARIABLE), false);
    } finally {
      mock.timers.reset();
    }
  });

  it("过场属性到点自动摘掉：不会把全站过渡永久留在 680ms", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const root = fakeRoot();
      startThemeSwap({ root, direction: "light", apply: () => applyTheme(root, "light") });

      assert.equal(root.attributes.get(THEME_TRANSITION_ATTRIBUTE), "to-light");
      mock.timers.tick(THEME_SWAP_HOLD_MS - 20);
      assert.equal(root.attributes.has(THEME_TRANSITION_ATTRIBUTE), true, "光晕没播完就摘会看到它「啪」地消失");

      mock.timers.tick(40);
      assert.equal(root.attributes.has(THEME_TRANSITION_ATTRIBUTE), false);
      assert.equal(root.variables.has(THEME_MOTION_VARIABLE), false);
      assert.equal(root.dataset.theme, "light");
    } finally {
      mock.timers.reset();
    }
  });

  it("收尾句柄可提前摘掉属性（连续快速切换时不叠加）", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const root = fakeRoot();
      const release = startThemeSwap({ root, direction: "dark", apply: () => applyTheme(root, "dark") });

      release();
      release(); // 幂等：多调一次不该抛，也不该影响后续
      assert.equal(root.attributes.has(THEME_TRANSITION_ATTRIBUTE), false);
      assert.equal(root.variables.has(THEME_MOTION_VARIABLE), false);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("主题过场的 TS ↔ CSS 契约", () => {
  it("globals.css 的 --motion-theme 兜底值与 THEME_SWAP_MS 一致", () => {
    const token = globalsCss().match(/--motion-theme:\s*(\d+)ms/);

    assert.ok(token, "globals.css 必须声明 --motion-theme 兜底值，否则读 CSS 的人看不到过场时长");
    assert.equal(
      Number(token[1]),
      THEME_SWAP_MS,
      `CSS 兜底值与 lib/themeTransition.ts 的 THEME_SWAP_MS 不一致：CSS=${token[1]}ms TS=${THEME_SWAP_MS}ms`,
    );
  });

  it("慢速过渡只在 [data-theme-transition] 窗口内接管，并由 --motion-theme 驱动", () => {
    const css = globalsCss();

    assert.match(css, /:root\[data-theme-transition\]\s*\*/);
    assert.match(
      css,
      /transition-duration:\s*var\(--motion-theme/,
      "过场时长必须走 --motion-theme（startThemeSwap 写的内联值），不能在 CSS 里再写死一个数",
    );
    assert.match(css, /@media \(prefers-reduced-motion: no-preference\)/);
  });

  it("方向性光晕两层都在：body::after + theme-wash + to-dark/to-light", () => {
    const css = globalsCss();

    assert.match(css, /:root\[data-theme-transition\] body::after/);
    assert.match(css, /@keyframes theme-wash/);
    assert.match(css, new RegExp(`:root\\[${THEME_TRANSITION_ATTRIBUTE}="to-dark"\\] body::after`));
    assert.match(css, new RegExp(`:root\\[${THEME_TRANSITION_ATTRIBUTE}="to-light"\\] body::after`));
  });

  it("拾取器滑块由 TSX 的 data-active-index 与 CSS 的 --active-index 对接", () => {
    const css = readFileSync(resolve(process.cwd(), "components/theme/ThemeModePicker.module.css"), "utf8");
    const tsx = readFileSync(resolve(process.cwd(), "components/theme/ThemeModePicker.tsx"), "utf8");

    assert.match(tsx, /data-active-index=\{activeIndex\}/);
    assert.match(css, /\.picker\[data-active-index="1"\]/);
    assert.match(css, /\.picker\[data-active-index="2"\]/);
    assert.match(
      css,
      /transform:\s*translateX\(calc\(var\(--active-index\)/,
      "指示条必须靠 --active-index 平移，否则换挡又变回「旧高亮消失、新高亮出现」",
    );
  });
});
