// @vitest-environment jsdom
/**
 * BLF-1123：弹层初始聚焦的**真实 DOM**行为测试。
 *
 * `lib/modalFocus.test.ts` 测的是「选谁」的规则；本文件测的是**接线**：
 * 把真实的 `Dialog` / `Drawer` / `Confirm` 挂到 jsdom 里，断言
 * 「打开弹窗后初始焦点在表单字段、不在关闭按钮」，并覆盖关闭后的焦点归还。
 *
 * 用 jsdom 而非 node:test 的原因：这两条只能在真实 DOM 上验证 —— 需要
 * `document.activeElement`、`Element.contains` 与真实的 `focus()` 语义。
 * 走 vitest（`test:motion`），与 `api.upload.vitest.test.ts` 同一个理由。
 *
 * ⚠️ 这里测不到的：中文输入法被打断（症状②）。jsdom 没有 IME 管线，
 * 无法断言「拼音首字母是否被裸字母上屏」。症状②的证据是真实 Chromium 实测
 * （见 PR 说明）：只修落点、保留 30ms 延迟时仍复现，故本次把延迟聚焦改为
 * 同步聚焦 + 「不抢走用户已放入弹层的焦点」的兜底。
 * 本文件用了一条**代理断言**守住它：聚焦必须在**同一轮同步**内完成，
 * 不允许存在「等一会儿才聚焦」的窗口 —— 一旦有人把 setTimeout 加回来，
 * 这条会失败，从而挡住症状②的回潮。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";

import {
  Confirm,
  Dialog,
  Drawer,
  type ConfirmProps,
  type DialogProps,
  type DrawerProps,
} from "../components/ui/Modal";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** 与「新建项目」弹层同构的正文：先出现的是项目名称输入框。 */
function formBody() {
  return createElement(
    "div",
    null,
    createElement("label", null, "项目名称", createElement("input", { placeholder: "项目名称" })),
    createElement("label", null, "项目编号", createElement("input", { placeholder: "项目编号" })),
  );
}

/**
 * 建弹层元素。
 *
 * `children` 必须并进 props 而不是当第三个参数传：`DialogProps.children` 是
 * 必填项，`createElement` 的第三个参数不参与该重载的类型推导，会报
 * 「Property 'children' is missing」。
 */
function dialog(props: Omit<DialogProps, "children">, children: ReactNode = formBody()) {
  return createElement(Dialog, { ...props, children });
}

function drawer(props: Omit<DrawerProps, "children">, children: ReactNode = formBody()) {
  return createElement(Drawer, { ...props, children });
}

function confirm(props: ConfirmProps) {
  return createElement(Confirm, props);
}

function closeButton(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>("[data-modal-close]");
  if (!el) throw new Error("关闭按钮没渲染出来");
  return el;
}

describe("Dialog 初始聚焦（BLF-1123 症状①）", () => {
  it("打开后焦点落在正文表单字段，**不在**关闭按钮上", () => {
    render(dialog({ open: true, onClose: () => {}, title: "新建项目" }));

    const active = document.activeElement as HTMLElement;
    expect(active.tagName).toBe("INPUT");
    expect(active.getAttribute("placeholder")).toBe("项目名称");
    expect(active).not.toBe(closeButton());
  });

  it("聚焦是同步完成的：不允许存在「稍后才聚焦」的空窗（症状②的代理断言）", () => {
    // 不 await 任何 tick：若实现退回 setTimeout(…, 30)，此时 activeElement
    // 仍是 body，本断言失败。
    render(dialog({ open: true, onClose: () => {}, title: "新建项目" }));
    expect((document.activeElement as HTMLElement).tagName).toBe("INPUT");
  });

  it("等过 30ms 之后焦点依然在表单字段上（延迟兜底不抢焦点）", async () => {
    vi.useFakeTimers();
    try {
      render(dialog({ open: true, onClose: () => {}, title: "新建项目" }));
      // 模拟用户在这 30ms 内自己点进第二个字段
      const second = document.querySelectorAll<HTMLInputElement>("input")[1];
      second.focus();
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      // 兜底定时器绝不能把焦点抢回「第一个」字段
      expect(document.activeElement).toBe(second);
    } finally {
      vi.useRealTimers();
    }
  });

  it("重渲染（同一弹层）不抢走用户已放进弹层的焦点", () => {
    const view = render(dialog({ open: true, onClose: () => {}, title: "新建项目" }));
    const second = view.container.ownerDocument.querySelectorAll<HTMLInputElement>("input")[1];
    // 用户自己点到了第二个字段
    second.focus();
    expect(document.activeElement).toBe(second);
    // 同一弹层重渲染：焦点在弹层内就应当原样保留，不能被拉回第一个字段
    view.rerender(dialog({ open: true, onClose: () => {}, title: "新建项目" }));
    expect(document.activeElement).toBe(second);
  });

  it("StrictMode 下 effect 跑两遍，焦点仍稳定落在第一个表单字段（不抖动到别处）", () => {
    // React 18 StrictMode 会挂载→清理→再挂载，effect 因此跑两遍。
    // 第二遍时焦点已经在弹层内部了，靠「已在弹层内就不抢」的守卫短路，
    // 结果必须与单遍一致（第一个字段），而不是漂到第二个字段或关闭按钮。
    render(createElement(StrictMode, null, dialog({ open: true, onClose: () => {}, title: "新建项目" })));
    const inputs = document.querySelectorAll<HTMLInputElement>("input");
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(document.activeElement).toBe(inputs[0]);
    expect(document.activeElement).not.toBe(closeButton());
  });

  it("正文里的 tabindex=-1 / aria-hidden 控件不被当作落点", () => {
    render(
      dialog(
        { open: true, onClose: () => {}, title: "上传" },
        createElement(
          "div",
          null,
          createElement("input", { type: "file", tabIndex: -1, "aria-hidden": "true" }),
          createElement("input", { placeholder: "真正的字段" }),
        ),
      ),
    );
    expect((document.activeElement as HTMLElement).getAttribute("placeholder")).toBe("真正的字段");
  });
});

describe("Drawer 初始聚焦", () => {
  it("抽屉打开后焦点也在正文表单字段，而不是关闭按钮", () => {
    render(drawer({ open: true, onClose: () => {}, title: "联系人" }));
    const active = document.activeElement as HTMLElement;
    expect(active.tagName).toBe("INPUT");
    expect(active).not.toBe(closeButton());
  });
});

describe("Confirm 初始聚焦（无表单字段的弹层）", () => {
  it("没有表单字段时焦点落到弹层内可聚焦按钮，不丢焦点", () => {
    render(
      confirm({
        open: true,
        title: "确认删除",
        text: "删除后不可恢复",
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    const active = document.activeElement as HTMLElement;
    expect(active.tagName).toBe("BUTTON");
    // 关闭按钮被排除在「初始落点」之外，焦点应在页脚的取消/确定上
    expect(active).not.toBe(closeButton());
    expect(["取消", "确定"]).toContain(active.textContent?.trim());
  });

  it("弹层内没有任何可聚焦控件时，兜底聚焦 panel 自身（焦点不丢到 body）", () => {
    // Confirm 的页脚永远有「取消/确定」两个按钮，因此要测 `(first ?? panel)` 的
    // panel 兜底，得用「正文无控件、也不传 footer」的 Dialog：
    // 此时唯一的 button 是关闭按钮（被排除），落点解析为 null → 必须退回 panel。
    render(
      dialog(
        { open: true, onClose: () => {}, title: "纯文本弹层" },
        createElement("p", null, "只有一段说明文字"),
      ),
    );
    const active = document.activeElement as HTMLElement;
    expect(active.getAttribute("role")).toBe("dialog");
    expect(active).not.toBe(document.body);
  });
});

describe("焦点归还（关闭后回到触发元素）", () => {
  it("关闭弹窗后焦点归还给打开它的那个按钮", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "新建项目";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const view = render(dialog({ open: true, onClose: () => {}, title: "新建项目" }));
    expect((document.activeElement as HTMLElement).tagName).toBe("INPUT");

    // 关闭：AnimatePresence 的 onExitComplete 驱动归还
    await act(async () => {
      view.rerender(dialog({ open: false, onClose: () => {}, title: "新建项目" }));
    });
    // framer-motion 的退出动画在 jsdom 下没有真实时长，等一轮宏任务让 onExitComplete 触发
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.activeElement).toBe(trigger);
  });

  it("打开时若焦点已在弹层内，关闭后仍归还给触发元素（不是弹层内部元素）", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "编辑";
    document.body.appendChild(trigger);
    trigger.focus();

    const view = render(dialog({ open: true, onClose: () => {}, title: "编辑项目" }));
    // 用户在弹层里移动过焦点
    document.querySelectorAll<HTMLInputElement>("input")[1].focus();

    await act(async () => {
      view.rerender(dialog({ open: false, onClose: () => {}, title: "编辑项目" }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.activeElement).toBe(trigger);
  });
});

describe("不得回归：Esc / Tab 循环 / dirty 二次确认", () => {
  it("Esc 触发关闭", async () => {
    const onClose = vi.fn();
    render(dialog({ open: true, onClose, title: "新建项目" }));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dirty 时 Esc 不直接关闭，改为弹二次确认", async () => {
    const onClose = vi.fn();
    render(dialog({ open: true, onClose, dirty: true, title: "新建项目" }));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("有未保存的修改");
  });

  it("Tab 在最后一个可聚焦元素上回绕到第一个", async () => {
    render(dialog({ open: true, onClose: () => {}, title: "新建项目" }));

    // Tab 锁定会按 `offsetParent !== null` 过滤不可见元素，而 jsdom 没有布局引擎、
    // offsetParent 恒为 null —— 不处理的话所有节点都被滤掉，测不到回绕。
    // 这里把 offsetParent 伪装成非 null，让本用例验证的是「回绕逻辑」本身
    // （真实浏览器里的可见性过滤由 Modal.tsx 的 filter 承担）。
    const focusables = Array.from(document.querySelectorAll<HTMLElement>("button, input"));
    for (const el of focusables) {
      Object.defineProperty(el, "offsetParent", { value: document.body, configurable: true });
    }

    const last = focusables[focusables.length - 1];
    last.focus();
    expect(document.activeElement).toBe(last);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(focusables[0]);
  });
});
