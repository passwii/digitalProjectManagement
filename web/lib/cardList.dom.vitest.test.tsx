// @vitest-environment jsdom
/**
 * 手机端卡片流的**真实 DOM**行为测试（BLF-1127/S5，决策 D4）。
 *
 * 测的是两页共用的接线，不测样式（CSS Modules 的类名是哈希的）：
 *   · 同一份数据进表格与卡片流：字段 / 操作一个不少（卡片化不得丢字段丢入口）；
 *   · 定位目标：表格行与卡片带相同的 `data-target-id`，命中卡带 `data-hit`；
 *   · 操作区截断冒泡：点「编辑」不能顺带触发整卡 onSelect（进详情）；
 *   · `useVisibleTargetScroll`：只滚当前可见的那份（另一视图 `display: none`），
 *     一个都不可见时退回第一份、一个都没有时不崩。
 *
 * 查询一律走 `data-cardlist` / `data-card` 契约表面（与验收脚本同口径）。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

import {
  CardItem,
  CardList,
  DesktopTable,
  useVisibleTargetScroll,
} from "../components/ui/CardList";
import { DesktopTableFrame } from "../components/ui/ListPageLayout";

afterEach(() => cleanup());

function projectCard(onSelect?: () => void) {
  return (
    <CardItem
      title={<span>河西数据中心</span>}
      code="PRJ-2026-001"
      fields={[
        { label: "负责人", value: "张伟" },
        { label: "预算", value: "¥1,200,000 元", mono: true },
      ]}
      actions={
        <>
          <button type="button" className="btn-ghost btn-xs">
            编辑
          </button>
          <button type="button" className="btn-ghost btn-xs btn-danger-outline">
            删除
          </button>
        </>
      }
      onSelect={onSelect}
      targetId={7}
      hit
    />
  );
}

describe("CardList / CardItem（D4 卡片流）", () => {
  it("容器带契约属性，卡片字段与操作齐全（不丢字段不丢入口）", () => {
    render(<CardList label="项目台账">{projectCard()}</CardList>);
    const list = document.querySelector('[data-cardlist="项目台账"]');
    expect(list?.getAttribute("role")).toBe("list");
    const card = list?.querySelector("[data-card]");
    expect(card?.getAttribute("role")).toBe("listitem");
    const text = card?.textContent ?? "";
    for (const want of [
      "河西数据中心",
      "PRJ-2026-001",
      "负责人",
      "张伟",
      "预算",
      "¥1,200,000 元",
      "编辑",
      "删除",
    ]) {
      expect(text).toContain(want);
    }
  });

  it("定位目标：data-target-id 与表格行同值，命中带 data-hit", () => {
    render(<CardList label="立项审批">{projectCard()}</CardList>);
    const card = document.querySelector("[data-card]");
    expect(card?.getAttribute("data-target-id")).toBe("7");
    expect(card?.getAttribute("data-hit")).toBe("true");
  });

  it("点操作按钮不触发整卡 onSelect（操作区截断冒泡）", () => {
    const onSelect = vi.fn();
    render(<CardList label="项目台账">{projectCard(onSelect)}</CardList>);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("点卡片正文触发 onSelect（表格 clickable-row 的卡片形态）", () => {
    const onSelect = vi.fn();
    render(<CardList label="项目台账">{projectCard(onSelect)}</CardList>);
    fireEvent.click(document.querySelector("[data-card]")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("DesktopTable 原样渲染表格（桌面视图零改动）", () => {
    render(
      <DesktopTable>
        <table className="grid">
          <tbody>
            <tr>
              <td>行</td>
            </tr>
          </tbody>
        </table>
      </DesktopTable>,
    );
    const wrap = document.querySelector(".table-scroll");
    expect(wrap?.querySelector("table.grid td")?.textContent).toBe("行");
  });

  it("DesktopTableFrame 与 DesktopTable 都保留 table-scroll 语义", () => {
    render(
      <>
        <DesktopTable><table className="grid"><tbody><tr><td>旧</td></tr></tbody></table></DesktopTable>
        <DesktopTableFrame><table className="grid"><tbody><tr><td>新</td></tr></tbody></table></DesktopTableFrame>
      </>,
    );

    expect(document.querySelectorAll("table.grid")).toHaveLength(2);
    expect(document.querySelectorAll(".table-scroll")).toHaveLength(2);
    expect(document.body.textContent).toContain("旧");
    expect(document.body.textContent).toContain("新");
  });
});

describe("useVisibleTargetScroll", () => {
  function Probe({ target, ready }: { target: number; ready: boolean }) {
    useVisibleTargetScroll(target, ready);
    return null;
  }

  it("目标不存在时不崩（空态 / 加载态）", () => {
    expect(() => render(<Probe target={99} ready />)).not.toThrow();
  });

  it("ready 为 false 时不滚动", () => {
    const scroll = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scroll;
    render(
      <>
        <div data-target-id="5">
          <button type="button">操作</button>
        </div>
        <Probe target={5} ready={false} />
      </>,
    );
    expect(scroll).not.toHaveBeenCalled();
    delete (window.HTMLElement.prototype as unknown as Record<string, unknown>)
      .scrollIntoView;
  });

  it("两份同 id 时滚第一份（jsdom 里都不可见 → 退回首份，不崩）", () => {
    const scroll = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scroll;
    render(
      <>
        <div data-target-id="5">
          <button type="button">表格操作</button>
        </div>
        <div data-target-id="5">
          <button type="button">卡片操作</button>
        </div>
        <Probe target={5} ready />
      </>,
    );
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.instances[0].textContent).toContain("表格操作");
    delete (window.HTMLElement.prototype as unknown as Record<string, unknown>)
      .scrollIntoView;
  });
});
