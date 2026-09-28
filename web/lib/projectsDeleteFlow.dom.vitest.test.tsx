// @vitest-environment jsdom
/**
 * 项目台账软删除的**真实 DOM**行为测试。
 *
 * 覆盖两件事：
 *   · 列表行 / 卡片的「删除」入口只在管理员可见，点击把项目交给页面处理；
 *   · 删除是**两步确认**：第一步「继续删除」只进入下一步，不直接执行；
 *     第二步「确认删除」才触发最终回调。
 *
 * 两步确认行为被抽到 `ProjectDeleteDialogs` 组件里，这里直接挂真实弹层验证，
 * 避免把页面级（useMenus / useUrlState / 请求）依赖搬进单测。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

import { ProjectsListContent } from "../app/(dashboard)/projects/ProjectsListContent";
import { ProjectDeleteDialogs } from "../app/(dashboard)/projects/ProjectDeleteDialogs";
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

function renderList(canDelete: boolean, onDelete = vi.fn()) {
  render(
    <ProjectsListContent
      items={[PROJECT]}
      page={1}
      size={15}
      total={1}
      loading={false}
      scopeText=""
      onPageChange={() => {}}
      canDelete={canDelete}
      onDelete={onDelete}
    />,
  );
  return onDelete;
}

describe("项目台账「删除」入口", () => {
  it("管理员可见「删除」，点击把该项目交给删除流程", () => {
    const onDelete = renderList(true);
    // 同一份数据渲染表格与卡片流两份，按钮数量 ≥ 1
    const buttons = screen.getAllByRole("button", { name: "删除" });
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(buttons[0]);
    expect(onDelete).toHaveBeenCalledWith(PROJECT);
  });

  it("非管理员不渲染「删除」", () => {
    renderList(false);
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    // 编辑入口仍在，说明只是隐藏了删除
    expect(screen.getAllByRole("button", { name: "编辑" }).length).toBeGreaterThanOrEqual(1);
  });
});

describe("软删除两步确认", () => {
  it("第一步只说明影响，点「继续删除」进入第二步而不执行删除", () => {
    const onNextStep = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ProjectDeleteDialogs
        target={PROJECT}
        step={1}
        onNextStep={onNextStep}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText(/删除项目「河西数据中心」/)).toBeTruthy();
    // 第一步不存在「确认删除」按钮，避免一步删掉
    expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "继续删除" }));
    expect(onNextStep).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("第二步点「确认删除」才执行最终删除", () => {
    const onConfirm = vi.fn();
    render(
      <ProjectDeleteDialogs
        target={PROJECT}
        step={2}
        onNextStep={() => {}}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText(/再次确认删除「河西数据中心」/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "继续删除" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("取消回调由两步弹窗共用", () => {
    const onCancel = vi.fn();
    render(
      <ProjectDeleteDialogs
        target={PROJECT}
        step={2}
        onNextStep={() => {}}
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
