// @vitest-environment jsdom
/**
 * 回归测试：Dialog 里打开日期弹层时，Esc 只关日期弹层，不关整个弹窗。
 *
 * 这是一条**集成**测试而不是组件测试，因为 bug 只在两层弹层叠加时出现：
 * `Modal` 的 Esc 监听挂在 document 的 capture 阶段，先于 React 的事件派发执行，
 * 组件内部无法抢占，只能靠 `nestedPopover` 登记簿让 Modal 主动放行。
 * 只测 `DatePicker` 本身是测不出这个 bug 的。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { DatePicker } from "../components/ui/DatePicker";
import { Dialog } from "../components/ui/Modal";

afterEach(() => {
  cleanup();
});

function Harness() {
  const [open, setOpen] = useState(true);
  const [date, setDate] = useState("");
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="编辑任务" data-modal-body>
      <label className="field">
        <span className="field-label">计划开始</span>
        <DatePicker value={date} onChange={setDate} ariaLabel="计划开始" />
      </label>
    </Dialog>
  );
}

describe("日期弹层嵌套在 Dialog 内", () => {
  it("打开日期弹层后按 Esc，只关日期弹层，Dialog 保持打开", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "计划开始" }));
    expect(screen.getByRole("dialog", { name: "日期选择" })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "日期选择" }), { key: "Escape" });

    // 日期弹层关了
    expect(screen.queryByRole("dialog", { name: "日期选择" })).toBeNull();
    // Dialog 还在 —— 改动前这里会是 null，整个弹窗被一次 Esc 关掉
    expect(screen.getByText("编辑任务")).toBeTruthy();
  });

  it("日期弹层关闭后，Esc 恢复为关闭 Dialog", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "计划开始" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "日期选择" }), { key: "Escape" });

    // 弹层已关，再按一次 Esc 应当落到 Dialog 身上
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByText("编辑任务")).toBeNull();
  });

  it("日期弹层没打开时，Esc 行为与改动前完全一致（直接关 Dialog）", () => {
    render(<Harness />);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByText("编辑任务")).toBeNull();
  });
});
