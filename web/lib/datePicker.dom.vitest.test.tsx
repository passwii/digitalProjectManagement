// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DatePicker,
  DateRangePicker,
  MonthPicker,
} from "../components/ui/DatePicker";
import Field from "../components/ui/Field";

afterEach(() => {
  cleanup();
});

function openTrigger(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** 打开后拿到的日期格：role=gridcell，aria-label 是完整中文日期。 */
function days() {
  return screen.getAllByRole("gridcell");
}

describe("随表单提交（name）", () => {
  it("单选提交的必须是 ISO 值，不能是展示用的中文", () => {
    render(<DatePicker name="purchase_date" value="2026-09-29" onChange={() => {}} />);
    const hidden = document.querySelector('input[type="hidden"][name="purchase_date"]') as HTMLInputElement;
    expect(hidden.value).toBe("2026-09-29");
  });

  it("未选择时提交空串，而不是占位文案", () => {
    render(<DatePicker name="purchase_date" value="" onChange={() => {}} />);
    const hidden = document.querySelector('input[type="hidden"][name="purchase_date"]') as HTMLInputElement;
    expect(hidden.value).toBe("");
  });

  it("选完新日期后 hidden 跟着变", () => {
    const Wrapper = () => {
      const [v, setV] = useState("2026-09-29");
      return <DatePicker name="d" value={v} onChange={setV} />;
    };
    render(<Wrapper />);
    openTrigger("选择日期");
    fireEvent.click(days()[9]);
    const hidden = document.querySelector('input[type="hidden"][name="d"]') as HTMLInputElement;
    expect(hidden.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(hidden.value).not.toBe("2026 年 9 月 29 日");
  });

  it("月份提交 YYYY-MM", () => {
    render(<MonthPicker name="m" value="2026-09" onChange={() => {}} />);
    const hidden = document.querySelector('input[type="hidden"][name="m"]') as HTMLInputElement;
    expect(hidden.value).toBe("2026-09");
  });

  it("区间映射回原生的起始日期语义", () => {
    render(<DateRangePicker name="from" value={{ from: "2026-09-01", to: "2026-09-30" }} onChange={() => {}} />);
    const hidden = document.querySelector('input[type="hidden"][name="from"]') as HTMLInputElement;
    expect(hidden.value).toBe("2026-09-01");
  });

  it("不传 name 就不渲染 hidden", () => {
    render(<DatePicker value="2026-09-29" onChange={() => {}} />);
    expect(document.querySelector('input[type="hidden"]')).toBeNull();
  });
});

describe("单选日期", () => {
  it("默认展示占位文案，不显示任何假日期", () => {
    render(<DatePicker value="" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "选择日期" }).textContent).toContain("选择日期");
  });

  it("有值时展示格式化后的日期", () => {
    render(<DatePicker value="2026-09-29" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "选择日期" }).textContent).toContain("2026 年 9 月 29 日");
  });

  it("点击触发器展开月历，再点收起", () => {
    render(<DatePicker value="" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: "选择日期" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    openTrigger("选择日期");
    expect(screen.getByRole("dialog", { name: "日期选择" })).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("选中某天后回调精确的 YYYY-MM-DD 并关闭弹层", () => {
    const onChange = vi.fn();
    render(<DatePicker value="2026-09-29" onChange={onChange} />);
    openTrigger("选择日期");
    fireEvent.click(screen.getByLabelText("2026年9月15日 星期二"));
    // 值契约必须与原生 input type=date 完全一致，否则后端载荷会变形
    expect(onChange).toHaveBeenCalledWith("2026-09-15");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("月历固定 42 格，含上下月补白", () => {
    render(<DatePicker value="2026-09-29" onChange={() => {}} />);
    openTrigger("选择日期");
    expect(days()).toHaveLength(42);
  });

  it("表头是中文周几且以周一开头", () => {
    render(<DatePicker value="2026-09-29" onChange={() => {}} />);
    openTrigger("选择日期");
    const headers = screen.getAllByRole("columnheader").map((el) => el.textContent);
    expect(headers).toEqual(["一", "二", "三", "四", "五", "六", "日"]);
  });

  it("日期格的无障碍名称是完整中文日期，不是裸数字", () => {
    render(<DatePicker value="2026-09-29" onChange={() => {}} />);
    openTrigger("选择日期");
    // 只读「15」对屏幕阅读器毫无意义
    expect(screen.getByLabelText("2026年9月15日 星期二")).toBeTruthy();
  });
});

describe("min / max 边界", () => {
  it("越界的日期被标记为禁用且不触发回调", () => {
    const onChange = vi.fn();
    render(<DatePicker value="2026-09-15" onChange={onChange} min="2026-09-10" max="2026-09-20" />);
    openTrigger("选择日期");
    const out = screen.getByLabelText("2026年9月5日 星期六");
    expect(out.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(out);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("区间内的日期可选", () => {
    const onChange = vi.fn();
    render(<DatePicker value="2026-09-15" onChange={onChange} min="2026-09-10" max="2026-09-20" />);
    openTrigger("选择日期");
    fireEvent.click(screen.getByLabelText("2026年9月12日 星期六"));
    expect(onChange).toHaveBeenCalledWith("2026-09-12");
  });

  it("只有 min 时下界之前不可选", () => {
    render(<DatePicker value="2026-09-15" onChange={() => {}} min="2026-09-10" />);
    openTrigger("选择日期");
    expect(screen.getByLabelText("2026年9月5日 星期六").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByLabelText("2026年9月12日 星期六").getAttribute("aria-disabled")).toBeNull();
  });
});

describe("快捷选择", () => {
  it("点「清除」回调空字符串", () => {
    const onChange = vi.fn();
    render(<DatePicker value="2026-09-15" onChange={onChange} />);
    openTrigger("选择日期");
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("未选值时「清除」是禁用的", () => {
    render(<DatePicker value="" onChange={() => {}} />);
    openTrigger("选择日期");
    expect((screen.getByRole("button", { name: "清除" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("「今天」产出本地当天的 YYYY-MM-DD", () => {
    const onChange = vi.fn();
    render(<DatePicker value="" onChange={onChange} />);
    openTrigger("选择日期");
    fireEvent.click(screen.getByRole("button", { name: "今天" }));
    const expected = new Date();
    const iso = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, "0")}-${String(expected.getDate()).padStart(2, "0")}`;
    expect(onChange).toHaveBeenCalledWith(iso);
  });

  it("quick=false 时不渲染快捷条", () => {
    render(<DatePicker value="" onChange={() => {}} quick={false} />);
    openTrigger("选择日期");
    expect(screen.queryByRole("button", { name: "今天" })).toBeNull();
  });
});

describe("键盘与焦点", () => {
  it("Esc 关闭弹层并把焦点还给触发器", () => {
    render(<DatePicker value="2026-09-29" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: "选择日期" });
    openTrigger("选择日期");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "日期选择" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // 键盘用户不能丢失位置
    expect(document.activeElement).toBe(trigger);
  });

  it("整个月历只有一格可 Tab，不会变成 42 个停留点", () => {
    render(<DatePicker value="2026-09-29" onChange={() => {}} />);
    openTrigger("选择日期");
    const tabbable = days().filter((el) => el.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(days().filter((el) => el.getAttribute("tabindex") === "-1")).toHaveLength(41);
  });

  it("方向键在日期间移动焦点", () => {
    render(<DatePicker value="2026-09-29" onChange={() => {}} />);
    openTrigger("选择日期");
    const grid = screen.getByRole("grid", { name: "选择日期" });
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    const focused = days().find((el) => el.getAttribute("tabindex") === "0");
    // 从 29 号(周二)右移到 30 号(周三)
    expect(focused?.getAttribute("aria-label")).toBe("2026年9月30日 星期三");
  });

  it("方向键跨月时把月历视野跟过去", () => {
    render(<DatePicker value="2026-09-30" onChange={() => {}} />);
    openTrigger("选择日期");
    const grid = screen.getByRole("grid", { name: "选择日期" });
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(screen.getByText("2026 年 10 月")).toBeTruthy();
  });

  it("Enter 选中当前焦点格", () => {
    const onChange = vi.fn();
    render(<DatePicker value="2026-09-29" onChange={onChange} />);
    openTrigger("选择日期");
    fireEvent.keyDown(screen.getByRole("grid", { name: "选择日期" }), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2026-09-29");
  });

  it("点击弹层外部关闭弹层", () => {
    render(
      <div>
        <button type="button">别处</button>
        <DatePicker value="" onChange={() => {}} />
      </div>,
    );
    openTrigger("选择日期");
    fireEvent.mouseDown(screen.getByRole("button", { name: "别处" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("月份导航", () => {
  it("上一月 / 下一月切换标题", () => {
    render(<DatePicker value="2026-09-15" onChange={() => {}} />);
    openTrigger("选择日期");
    fireEvent.click(screen.getByRole("button", { name: "上一月" }));
    expect(screen.getByText("2026 年 8 月")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一月" }));
    expect(screen.getByText("2026 年 9 月")).toBeTruthy();
  });

  it("翻到 min 所在月之前时禁用上一月", () => {
    render(<DatePicker value="2026-09-15" onChange={() => {}} min="2026-09-01" />);
    openTrigger("选择日期");
    expect((screen.getByRole("button", { name: "上一月" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("错误态与禁用态", () => {
  it("invalid 会加上错误边框类", () => {
    render(
      <Field label="预算期间结束" error="须晚于开始日期">
        <DatePicker value="" onChange={() => {}} invalid ariaLabel="预算期间结束" />
      </Field>,
    );
    const trigger = screen.getByRole("button", { name: "预算期间结束" });
    // `globals.css` 的 [aria-invalid] 规则只作用于原生元素，组件必须自己画出错误边框
    expect(trigger.className).toContain("triggerInvalid");
    // 错误文案仍由 Field 的 role="alert" 播报，与项目既有做法一致
    expect(screen.getByRole("alert").textContent).toBe("须晚于开始日期");
  });

  it("disabled 时触发器不可点", () => {
    render(<DatePicker value="2026-09-15" onChange={() => {}} disabled />);
    expect((screen.getByRole("button", { name: "选择日期" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("区间选择", () => {
  it("分两次点击定出起止，并自动纠正倒挂的顺序", () => {
    const onChange = vi.fn();
    render(<DateRangePicker value={{ from: "", to: "" }} onChange={onChange} />);
    openTrigger("选择日期区间");
    fireEvent.click(screen.getByLabelText("2026年9月20日 星期日"));
    expect(onChange).not.toHaveBeenCalled();
    // 先点了 20 号再点 15 号 → 自动对调，用户要的是「一个区间」而不是固定顺序
    fireEvent.click(screen.getByLabelText("2026年9月15日 星期二"));
    expect(onChange).toHaveBeenCalledWith({ from: "2026-09-15", to: "2026-09-20" });
  });

  it("两端齐备时触发器展示区间", () => {
    render(<DateRangePicker value={{ from: "2026-09-01", to: "2026-09-30" }} onChange={() => {}} />);
    const text = screen.getByRole("button", { name: "选择日期区间" }).textContent ?? "";
    expect(text).toContain("2026 年 9 月 1 日");
    expect(text).toContain("2026 年 9 月 30 日");
  });

  it("只选了一端时提示用户继续选", () => {
    render(<DateRangePicker value={{ from: "", to: "" }} onChange={() => {}} />);
    openTrigger("选择日期区间");
    expect(screen.getByText("选择起始日期")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("2026年9月20日 星期日"));
    expect(screen.getByText("再选一天作为结束日期")).toBeTruthy();
  });
});

describe("与 Field 的 <label> 共存", () => {
  /*
   * jsdom 不实现 label 的「转发点击」，所以这里断言不了「浏览器会多派发一次
   * 点击给触发器」这个真实故障，只能钉死它的根因：日期格必须是 <button>。
   * 一旦退回 <div>，点日期格会被 label 转发一次点击到触发器上，
   * 弹层当场自己关掉（区间选择的两段式直接废掉）。
   * 真正的复现要靠 Chromium，见 docs/superpowers/plans 里的验收记录。
   */
  it("日期格是 button 而非 div，避免 label 转发点击", () => {
    render(
      <Field label="单选日期">
        <DatePicker value="" onChange={() => {}} />
      </Field>,
    );
    openTrigger("选择日期");
    const cell = days()[0];
    expect(cell.tagName).toBe("BUTTON");
    expect(cell.getAttribute("type")).toBe("button");
  });

  it("弹层内每一个可点元素都是 button", () => {
    render(
      <Field label="按月选择">
        <MonthPicker value="2026-09" onChange={() => {}} />
      </Field>,
    );
    openTrigger("选择月份");
    const pop = screen.getByRole("dialog", { name: "月份选择" });
    const clickable = Array.from(pop.querySelectorAll("[role=gridcell], button"));
    expect(clickable.length).toBeGreaterThan(0);
    for (const node of clickable) expect(node.tagName).toBe("BUTTON");
  });
});

describe("月份选择", () => {
  // 月粒度下「今天 / 本周 / 本月」三个按钮会落到同一个当月，
  // 只保留「本月 / 清除」。
  it("快捷条只给本月和清除两个动作", () => {
    render(<MonthPicker value="2026-09" onChange={() => {}} quick />);
    openTrigger("选择月份");
    const pop = screen.getByRole("dialog", { name: "月份选择" });
    expect(screen.queryByRole("button", { name: "今天" })).toBeNull();
    expect(screen.queryByRole("button", { name: "本周" })).toBeNull();
    // 快捷条排在导航和 12 个月格之后，所以最后两个按钮就是它
    const buttons = Array.from(pop.querySelectorAll("button"));
    expect(buttons.slice(-2).map((b) => b.textContent)).toEqual(["本月", "清除"]);
  });

  it("产出 YYYY-MM，与原生 input type=month 一致", () => {
    const onChange = vi.fn();
    render(<MonthPicker value="2026-09" onChange={onChange} />);
    openTrigger("选择月份");
    fireEvent.click(screen.getByRole("gridcell", { name: "3 月" }));
    expect(onChange).toHaveBeenCalledWith("2026-03");
  });

  it("展示为中文月份", () => {
    render(<MonthPicker value="2026-09" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "选择月份" }).textContent).toContain("2026 年 9 月");
  });

  it("跨年翻页：上一年把 2026-09 带到 2025-09", () => {
    const onChange = vi.fn();
    render(<MonthPicker value="2026-09" onChange={onChange} />);
    openTrigger("选择月份");
    fireEvent.click(screen.getByRole("button", { name: "上一年" }));
    expect(screen.getByText("2025 年 9 月")).toBeTruthy();
  });

  it("min 之前的月份置灰，min 本身可选", () => {
    // min 是 `YYYY-MM` 月份键，与 MonthPicker 的 value 同构
    render(<MonthPicker value="2026-09" onChange={() => {}} min="2026-03" />);
    openTrigger("选择月份");
    expect((screen.getByRole("gridcell", { name: "1 月" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("gridcell", { name: "2 月" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("gridcell", { name: "3 月" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("max 之后的月份置灰", () => {
    render(<MonthPicker value="2026-09" onChange={() => {}} max="2026-06" />);
    openTrigger("选择月份");
    expect((screen.getByRole("gridcell", { name: "6 月" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("gridcell", { name: "7 月" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Esc 关闭并归还焦点", () => {
    render(<MonthPicker value="2026-09" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: "选择月份" });
    openTrigger("选择月份");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "月份选择" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
