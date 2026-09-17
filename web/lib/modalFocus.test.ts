/**
 * BLF-1123：弹层初始聚焦落点的纯逻辑测试（node:test 那套，无 DOM 依赖）。
 *
 * 覆盖「选谁」的规则本身。真实 DOM 下「焦点到底落在哪个元素」由
 * `lib/modalFocus.dom.vitest.test.ts` 用组件实测，两者分工：
 * 本文件测规则，那份测接线。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MODAL_BODY_ATTR,
  MODAL_CLOSE_ATTR,
  MODAL_FOCUSABLE_SELECTOR,
  isInitialFocusCandidate,
  pickInitialFocus,
  resolveInitialFocus,
} from "./modalFocus";

/** 造一个带属性表与 focus 记录的元素替身（不需要 DOM）。 */
function el(attrs: Record<string, string> = {}, opts: { disabled?: boolean } = {}) {
  const attributes: Record<string, string> = { ...attrs };
  let focusCount = 0;
  return {
    getAttribute: (name: string) => (name in attributes ? attributes[name] : null),
    disabled: opts.disabled,
    focus() {
      focusCount += 1;
    },
    get focusCount() {
      return focusCount;
    },
  };
}

/** 造一个按选择器分派的作用域替身：记录每个选择器返回了什么。 */
function scope(map: Record<string, unknown[]>) {
  const asked: string[] = [];
  return {
    asked,
    querySelectorAll(selector: string) {
      asked.push(selector);
      return map[selector] ?? [];
    },
    querySelector(selector: string) {
      asked.push(selector);
      return (map[selector] ?? [])[0] ?? null;
    },
  };
}

describe("初始聚焦候选判定", () => {
  it("普通按钮/输入框可以作落点", () => {
    assert.equal(isInitialFocusCandidate(el()), true);
    assert.equal(isInitialFocusCandidate(el({ type: "text" })), true);
  });

  it("关闭按钮被排除（本 bug 的错误落点）", () => {
    assert.equal(isInitialFocusCandidate(el({ [MODAL_CLOSE_ATTR]: "true" })), false);
  });

  it("aria-hidden / tabindex=-1 / disabled 都不作落点", () => {
    assert.equal(isInitialFocusCandidate(el({ "aria-hidden": "true" })), false);
    assert.equal(isInitialFocusCandidate(el({ tabindex: "-1" })), false);
    assert.equal(isInitialFocusCandidate(el({}, { disabled: true })), false);
  });

  it("没有 focus 能力的元素不是落点（并集选择器可能选中它）", () => {
    assert.equal(isInitialFocusCandidate({ getAttribute: () => null }), false);
  });

  it("null / undefined 安全返回 false", () => {
    assert.equal(isInitialFocusCandidate(null), false);
    assert.equal(isInitialFocusCandidate(undefined), false);
  });
});

describe("pickInitialFocus：按文档序取首个合格落点", () => {
  it("跳过被排除的元素，取它后面的第一个", () => {
    const close = el({ [MODAL_CLOSE_ATTR]: "true" });
    const hiddenFile = el({ "aria-hidden": "true", tabindex: "-1" });
    const name = el();
    const picked = pickInitialFocus(
      scope({ [MODAL_FOCUSABLE_SELECTOR]: [close, hiddenFile, name] }),
    );
    assert.equal(picked, name);
  });

  it("全部不合格时返回 null（由调用方退回 panel）", () => {
    const picked = pickInitialFocus(
      scope({ [MODAL_FOCUSABLE_SELECTOR]: [el({ [MODAL_CLOSE_ATTR]: "true" })] }),
    );
    assert.equal(picked, null);
  });
});

describe("resolveInitialFocus：正文优先，其次弹层其余控件", () => {
  it("正文里有表单控件时，取正文里的第一个（而不是 header 的关闭按钮）", () => {
    const close = el({ [MODAL_CLOSE_ATTR]: "true" });
    const bodyInput = el();
    const panel = scope({
      [`[${MODAL_BODY_ATTR}]`]: [scope({ [MODAL_FOCUSABLE_SELECTOR]: [bodyInput] })],
      [MODAL_FOCUSABLE_SELECTOR]: [close, bodyInput],
    });
    assert.equal(resolveInitialFocus(panel), bodyInput);
  });

  it("正文无可聚焦控件时退回弹层级查找（Confirm 这类无表单弹层）", () => {
    const close = el({ [MODAL_CLOSE_ATTR]: "true" });
    const okButton = el();
    const panel = scope({
      [`[${MODAL_BODY_ATTR}]`]: [scope({ [MODAL_FOCUSABLE_SELECTOR]: [] })],
      [MODAL_FOCUSABLE_SELECTOR]: [close, okButton],
    });
    assert.equal(resolveInitialFocus(panel), okButton);
  });

  it("没有正文标记时直接在弹层级查找", () => {
    const okButton = el();
    const panel = scope({ [MODAL_FOCUSABLE_SELECTOR]: [okButton] });
    assert.equal(resolveInitialFocus(panel), okButton);
  });

  it("空弹层返回 null（调用方兜底聚焦 panel 自身）", () => {
    const panel = scope({ [`[${MODAL_BODY_ATTR}]`]: [scope({ [MODAL_FOCUSABLE_SELECTOR]: [] })] });
    assert.equal(resolveInitialFocus(panel), null);
  });

  it("缺少 querySelector 的入参不抛异常", () => {
    assert.equal(resolveInitialFocus(null), null);
    assert.equal(resolveInitialFocus(undefined), null);
    assert.equal(resolveInitialFocus({} as never), null);
  });
});
