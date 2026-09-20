// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import TableToolbar from "../components/ui/TableToolbar";

afterEach(() => cleanup());

describe("TableToolbar", () => {
  it("renders the optional action in the right-side area", () => {
    render(
      <TableToolbar action={<button type="button">新建项目</button>}>
        <input aria-label="搜索项目" />
      </TableToolbar>,
    );

    const right = document.querySelector('[data-toolbar-right="true"]');
    expect(right?.querySelector("button")?.textContent).toBe("新建项目");
    expect(document.querySelector('[aria-label="搜索项目"]')).not.toBeNull();
  });

  it("does not render an action when it is omitted", () => {
    render(
      <TableToolbar>
        <input aria-label="搜索项目" />
      </TableToolbar>,
    );

    expect(document.querySelector('[data-toolbar-right="true"] button')).toBeNull();
  });
});
