// @vitest-environment jsdom
/**
 * 自绘 Select 的可访问名契约。
 *
 * 触发器（button[role=combobox]）的名字有两种来源：
 *   · 显式 aria-label；
 *   · 外层 <label> / <Field>（内部也是 <label>）包裹 —— 全库多数调用点是这种。
 * 展开后的 listbox 必须同样有可访问名，否则读屏用户在弹层里失去上下文。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { computeAccessibleName } from "dom-accessibility-api";

import Select from "../components/ui/Select";
import Field from "../components/ui/Field";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("自绘 Select 的可访问名", () => {
  it("Field 包裹时，触发器与展开的 listbox 都有可访问名", () => {
    render(
      <Field label="项目负责人">
        <Select defaultValue="u1">
          <option value="u1">张伟</option>
          <option value="u2">李娜</option>
        </Select>
      </Field>,
    );

    const trigger = screen.getByRole("combobox");
    expect(computeAccessibleName(trigger)).toContain("项目负责人");

    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox");
    expect(computeAccessibleName(listbox)).toContain("项目负责人");
  });

  it("显式 aria-label 时，listbox 沿用同一个名字", () => {
    render(
      <Select aria-label="选择入库批次" defaultValue="b1">
        <option value="b1">批次一</option>
      </Select>,
    );

    fireEvent.click(screen.getByRole("combobox"));
    expect(computeAccessibleName(screen.getByRole("listbox"))).toContain("选择入库批次");
  });
});
