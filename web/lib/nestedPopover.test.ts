import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasOpenNestedPopover,
  registerNestedPopover,
  resetNestedPopoverRegistry,
} from "./nestedPopover";

describe("嵌套弹层登记簿", () => {
  it("没有登记时 Modal 可以正常处理 Esc", () => {
    resetNestedPopoverRegistry();
    assert.equal(hasOpenNestedPopover(), false);
  });

  it("登记后挡住 Modal 的 Esc", () => {
    resetNestedPopoverRegistry();
    const release = registerNestedPopover();
    assert.equal(hasOpenNestedPopover(), true);
    release();
    assert.equal(hasOpenNestedPopover(), false);
  });

  it("重复注销不会把计数扣成负数", () => {
    resetNestedPopoverRegistry();
    const release = registerNestedPopover();
    // React 18 的 StrictMode 与 effect 重跑都可能让同一个弹层注销两次；
    // 若不幂等，计数会漂移且永不归零，Modal 的 Esc 就永久失灵。
    release();
    release();
    assert.equal(hasOpenNestedPopover(), false);
    const next = registerNestedPopover();
    assert.equal(hasOpenNestedPopover(), true);
    next();
  });

  it("多个弹层交叠时关掉一个不会提前放行 Esc", () => {
    resetNestedPopoverRegistry();
    const first = registerNestedPopover();
    const second = registerNestedPopover();
    first();
    // 第二个还开着 —— 用布尔开关会在此刻就误判为「没有嵌套弹层」
    assert.equal(hasOpenNestedPopover(), true);
    second();
    assert.equal(hasOpenNestedPopover(), false);
  });
});
