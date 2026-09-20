// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import {
  DesktopTableFrame,
  ListPageLayout,
  ListViewport,
} from "../components/ui/ListPageLayout";
import { ProjectsListContent } from "../app/(dashboard)/projects/page";

afterEach(() => cleanup());

describe("ListPageLayout", () => {
  it("保留工具栏、提示和主体的列表页结构", () => {
    render(
      <ListPageLayout
        toolbar={<div data-testid="toolbar">筛选</div>}
        notice={<div data-testid="notice">演示数据</div>}
      >
        <div data-testid="body">列表主体</div>
      </ListPageLayout>,
    );

    expect(document.querySelector('[data-list-page="true"]')).not.toBeNull();
    expect(document.querySelector('[data-list-toolbar="true"]')).not.toBeNull();
    expect(document.querySelector('[data-list-notice="true"]')).not.toBeNull();
    expect(document.querySelector('[data-list-content="true"]')).not.toBeNull();
  });

  it("把分页放在列表轨道 footer，主体和分页同属一个 viewport", () => {
    render(
      <ListViewport
        pagination={<nav data-testid="pagination">分页</nav>}
      >
        <div data-testid="body">表格</div>
      </ListViewport>,
    );

    const viewport = document.querySelector('[data-list-viewport="true"]');
    expect(viewport?.querySelector('[data-list-body="true"]')).not.toBeNull();
    expect(viewport?.querySelector('[data-list-pagination="true"]')).not.toBeNull();
    expect(viewport?.querySelector('[data-list-body="true"] + [data-list-pagination="true"]')).not.toBeNull();
  });

  it("桌面表格外壳不改写传入 table", () => {
    render(
      <DesktopTableFrame className="project-table-frame">
        <table className="grid"><tbody><tr><td>行</td></tr></tbody></table>
      </DesktopTableFrame>,
    );

    const table = document.querySelector("table.grid");
    expect(table?.querySelector("td")?.textContent).toBe("行");
    expect(document.querySelector(".project-table-frame")).not.toBeNull();
  });

  it("项目台账把响应式主体和分页接入同一轨道", () => {
    render(
      <ProjectsListContent
        items={[]}
        page={1}
        size={15}
        total={0}
        loading={false}
        scopeText=""
        onPageChange={() => {}}
      />,
    );

    const viewport = document.querySelector('[data-list-viewport="true"]');
    expect(viewport?.querySelector('[data-cardlist="项目台账"]')).not.toBeNull();
    expect(viewport?.querySelector("table.grid")).not.toBeNull();
    expect(viewport?.querySelector('[data-list-pagination="true"]')).not.toBeNull();
    expect(document.querySelector('[data-list-content="true"] > [data-list-viewport="true"]')).not.toBeNull();
  });
});
