// @vitest-environment jsdom
/**
 * 三态抽屉的手势仲裁回归（BLF-1131，PR #36 阻塞项）。
 *
 * Tia 拦下的问题：`.panel` 的 `touch-action: none` 按祖先链交集吃掉
 * half / full 下 `.body` 的 `pan-y`，列表在 `scrollTop > 0` 时根本滚不起来；
 * 而 `onPointerDown` 的提前 return 也恢复不了被祖先禁掉的 pan-y。
 * 修复：面板收窄为 `pan-y`（接管范围只剩把手 / 头部），仲裁只留在 TSX。
 *
 * 本文件钉住两层，改任一层都会红：
 *   1. CSS 层：`.panel` 必须是 `pan-y`（绝不能回退成 `none`）；
 *      half / full 的 `.body` 保持 `pan-y` 可滚；
 *   2. 手势层（真实 DOM）：列表滚过顶部时从列表起手 → 面板不跟手（位移 0）；
 *      回到顶部后同一手势 → 面板跟手（transform 被写值）。
 *
 * 真 Chrome 的滚动走查（`scripts/acceptance_blf1127_mobile.py` S3 段）仍是
 * 最终口径；这里是防回退的门，不是替代。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import BottomSheet from "../components/mobile/BottomSheet";
import { DRAG_SLOP } from "@/lib/sheetGesture";

// 不用 `new URL("…", import.meta.url)`：Vite 会把它当静态资源引用重写成
// dev-server 地址（http://localhost:3000/…），readFileSync 就报
// "The URL must be of scheme file"。走 fileURLToPath + path.resolve
// 避开这个 AST 模式，拿到的是真实磁盘路径。
const css = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../components/mobile/BottomSheet.module.css",
  ),
  "utf8",
);

/** 去掉 CSS 注释再断言：`.panel` 块里的注释会提到 grip / head 的
 *  `touch-action: none`，不剥掉是否定断言会被注释文字误伤。 */
function stripComments(rule: string): string {
  return rule.replace(/\/\*[\s\S]*?\*\//g, "");
}
function panelRule(): string {
  const m = css.match(/^\.panel\s*\{([^}]*)\}/m);
  if (!m) throw new Error("找不到 .panel 规则");
  return stripComments(m[1]);
}

describe("BottomSheet touch-action（PR #36 阻塞项）", () => {
  it(".panel 是 pan-y：祖先的 none 会按交集吃掉 body 的 pan-y", () => {
    const rule = panelRule();
    expect(rule).toMatch(/touch-action:\s*pan-y/);
    expect(rule).not.toMatch(/touch-action:\s*none/);
  });

  it("half / full 的 body 保持 pan-y 可滚", () => {
    expect(css).toMatch(
      /\.panel\[data-sheet="half"\] \.body,\s*\.panel\[data-sheet="full"\] \.body\s*\{[^}]*touch-action:\s*pan-y/,
    );
  });
});

function renderHalf() {
  const onStopChange = () => {};
  const onClose = () => {};
  const ui = render(
    <BottomSheet
      open
      stop="half"
      onStopChange={onStopChange}
      onClose={onClose}
      title="项目"
    >
      <div style={{ height: 1200 }}>卡片列表</div>
    </BottomSheet>,
  );
  const panel = document.querySelector("[data-sheet]") as HTMLElement;
  const body = document.querySelector("[data-sheet-body]") as HTMLElement;
  if (!panel || !body) throw new Error("抽屉没有渲染");
  return { ui, panel, body };
}

describe("BottomSheet 滚动优先仲裁", () => {
  it("列表滚过顶部：从列表起手拖不动面板", () => {
    const { ui, panel, body } = renderHalf();
    try {
      body.scrollTop = 60;
      fireEvent.pointerDown(body, { clientY: 400, pointerType: "touch" });
      fireEvent.pointerMove(panel, { clientY: 400 - 150, pointerType: "touch" });
      expect(panel.style.transform).toBe("");
    } finally {
      ui.unmount();
      cleanup();
    }
  });

  it("反向对照：回到顶部后同一手势面板跟手", () => {
    const { ui, panel, body } = renderHalf();
    try {
      body.scrollTop = 0;
      fireEvent.pointerDown(body, { clientY: 400, pointerType: "touch" });
      const dy = -(DRAG_SLOP + 100);
      fireEvent.pointerMove(panel, { clientY: 400 + dy, pointerType: "touch" });
      expect(panel.style.transform).not.toBe("");
    } finally {
      ui.unmount();
      cleanup();
    }
  });
});
