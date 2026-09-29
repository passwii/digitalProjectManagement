/**
 * 测试里驱动 DatePicker 的公共动作。
 *
 * 触发器是 button，没有 `change` 事件，所以「把日期设成 X」只能走真实交互：
 * 开弹层 → 翻到目标月 → 点那一天。原来的 `fireEvent.change(getByLabelText(…), …)`
 * 在迁移成 DatePicker 之后会静默失效（元素找得到，事件没人听），必须换掉。
 */
import { fireEvent, screen, within } from "@testing-library/react";

import { formatAriaDate } from "../dateCore";

/** 读触发器上的 ISO 原值（`data-value`）；空值返回 `""`。 */
export function dateValue(triggerName: string): string {
  return screen.getByRole("button", { name: triggerName }).getAttribute("data-value") ?? "";
}

function monthTitle(iso: string): string {
  const [year, month] = iso.split("-");
  return `${year} 年 ${Number(month)} 月`;
}

/** 打开弹层并翻到目标月份；返回弹层容器。 */
function openOnMonth(triggerName: string, iso: string): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: triggerName }));
  const pop = screen.getByRole("dialog", { name: "日期选择" });
  // 翻页是异步渲染的（React state），每翻一次都要重新拿到最新的标题节点。
  for (let guard = 0; guard < 240; guard += 1) {
    const title = within(pop).getByText(/\d+ 年 \d+ 月/).textContent ?? "";
    if (title.trim() === monthTitle(iso)) return pop;
    const [year, month] = iso.split("-").map(Number);
    const [curYear, curMonth] = (title.match(/(\d+) 年 (\d+) 月/) ?? []).slice(1).map(Number);
    if (!curYear) throw new Error(`读不出月份标题：${title}`);
    const forward = (year - curYear) * 12 + (month - curMonth) > 0;
    const btn = within(pop).getByRole("button", { name: forward ? "下一月" : "上一月" });
    if ((btn as HTMLButtonElement).disabled) {
      throw new Error(`翻不到 ${monthTitle(iso)}，${forward ? "下一月" : "上一月"} 已禁用`);
    }
    fireEvent.click(btn);
  }
  throw new Error(`翻不到 ${monthTitle(iso)}`);
}

/** 通过真实交互把某个 DatePicker 的值设成 `iso`（`YYYY-MM-DD`）。 */
export function setDate(triggerName: string, iso: string): void {
  const pop = openOnMonth(triggerName, iso);
  fireEvent.click(within(pop).getByRole("gridcell", { name: formatAriaDate(iso) }));
}
