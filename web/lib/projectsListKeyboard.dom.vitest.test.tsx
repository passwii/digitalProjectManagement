// @vitest-environment jsdom
/**
 * 项目台账桌面表格的键盘入口。
 *
 * 表格行整行点击进详情是为鼠标设计的；<tr> 不可聚焦，键盘用户没有等价入口。
 * 本测试锁定：操作列存在「查看」按钮，且触发与整行点击相同的 onSelect 回调。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ProjectsListContent } from "../app/(dashboard)/projects/ProjectsListContent";
import type { Project } from "../lib/api";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const PROJECT: Project = {
  id: 7,
  code: "PJ-2026-0007",
  name: "河西数据中心",
  type: "",
  dept_id: null,
  owner_id: 1,
  owner_name: "张伟",
  member_ids: [1],
  plan_start: null,
  plan_end: null,
  budget_total: 1200000,
  priority: "中",
  client: "河西集团",
  client_contact: "",
  client_phone: "",
  description: "",
  contract_status: "",
  status: "doing",
  progress: 0,
};

function renderList(onSelect = vi.fn()) {
  render(
    <ProjectsListContent
      items={[PROJECT]}
      page={1}
      size={15}
      total={1}
      loading={false}
      scopeText=""
      onPageChange={() => {}}
      onSelect={onSelect}
    />,
  );
  return onSelect;
}

describe("项目台账表格行的键盘入口", () => {
  it("桌面表格每行提供可聚焦的「查看」按钮并打开同一详情", () => {
    const onSelect = renderList();
    const view = screen.getAllByRole("button", { name: "查看" });
    expect(view.length).toBeGreaterThanOrEqual(1);

    view[0].focus();
    expect(document.activeElement).toBe(view[0]);

    fireEvent.click(view[0]);
    expect(onSelect).toHaveBeenCalledWith(PROJECT);
  });

  it("「查看」按钮的点击不冒泡到整行，避免重复触发", () => {
    const onSelect = renderList();
    fireEvent.click(screen.getAllByRole("button", { name: "查看" })[0]);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
