// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import PageHeader from "../components/ui/PageHeader";

afterEach(() => cleanup());

describe("PageHeader", () => {
  it("保留页面标题并把筛选与操作放入左右区域", () => {
    render(
      <PageHeader
        title="项目台账"
        filters={<input aria-label="搜索项目" />}
        actions={<button type="button">新建项目</button>}
      />,
    );

    expect(document.querySelector("h1.sr-only")?.textContent).toBe("项目台账");
    expect(document.querySelector('[data-page-header="true"]')).not.toBeNull();
    expect(document.querySelector('[data-page-header-title="true"]')?.textContent).toBe("项目台账");
    expect(document.querySelector('[data-page-header-filters="true"] input')).not.toBeNull();
    expect(document.querySelector('[data-page-header-actions="true"] button')?.textContent).toBe("新建项目");
  });

  it("没有筛选或操作时不创建空区域", () => {
    render(<PageHeader title="审批中心" />);

    expect(document.querySelector('[data-page-header-filters="true"]')).toBeNull();
    expect(document.querySelector('[data-page-header-actions="true"]')).toBeNull();
  });

  it("把自定义 class 连接到头部视觉容器", () => {
    render(<PageHeader title="报表" className="reports-header" />);
    expect(document.querySelector('[data-page-header="true"].reports-header')).not.toBeNull();
  });

  it("目标一级页面使用统一 PageHeader 头部", () => {
    const pages = [
      "projects",
      "partners",
      "contacts",
      "progress",
      "costs",
      "reports",
      "dashboard",
      "approvals",
      "finance",
      "admin",
    ];
    for (const page of pages) {
      const source = readFileSync(
        resolve(__dirname, `../app/(dashboard)/${page}/page.tsx`),
        "utf8",
      );
      expect(source, page).toContain("PageHeader");
      expect(source, page).not.toContain("PageActions");
    }
  });

  it("有筛选的页面不再保留一级 toolbar-card", () => {
    for (const page of ["progress", "costs", "reports", "finance"]) {
      const source = readFileSync(
        resolve(__dirname, `../app/(dashboard)/${page}/page.tsx`),
        "utf8",
      );
      expect(source, page).not.toContain('className="toolbar-card"');
    }
  });

  it("Reports 项目筛选保留桌面端宽度契约", () => {
    const source = readFileSync(
      resolve(__dirname, "../app/(dashboard)/reports/page.tsx"),
      "utf8",
    );
    const styles = readFileSync(
      resolve(__dirname, "../components/ui/PageHeader.module.css"),
      "utf8",
    );
    expect(source).toContain("reports-project-filter");
    expect(styles).toContain("min-width: 220px");
    expect(styles).toContain("max-width: min(50%, 540px)");
    expect(styles).toContain("max-width: none");
  });

  it("筛选控件支持等宽与二倍宽度布局", () => {
    const styles = readFileSync(
      resolve(__dirname, "../components/ui/PageHeader.module.css"),
      "utf8",
    );
    expect(styles).toContain("flex: 1 1 0");
    expect(styles).toContain(".filter-span-2");
    expect(styles).toContain("flex: 2 1 0");
  });

  it("Dashboard 不再提供支出报表入口", () => {
    const source = readFileSync(
      resolve(__dirname, "../app/(dashboard)/dashboard/page.tsx"),
      "utf8",
    );
    expect(source).not.toContain('href="/reports"');
  });

  it("Progress、Costs 和 Reports 使用无前缀筛选控件", () => {
    for (const page of ["progress", "costs", "reports"]) {
      const source = readFileSync(
        resolve(__dirname, `../app/(dashboard)/${page}/page.tsx`),
        "utf8",
      );
      expect(source, page).not.toContain("<span>项目</span>");
      expect(source, page).not.toContain("<span>部门</span>");
      expect(source, page).not.toContain("<span>人员</span>");
      expect(source, page).not.toContain("<span>月份</span>");
    }
  });

  it("桌面端限制筛选区最大宽度并隔离操作区", () => {
    const styles = readFileSync(
      resolve(__dirname, "../components/ui/PageHeader.module.css"),
      "utf8",
    );
    expect(styles).toContain("flex: 0 1 960px");
    expect(styles).toContain("border-left: 1px solid var(--line)");
    expect(styles).toContain("padding-left: 16px");
    expect(styles).toContain("border-left: 0");
    expect(styles).toContain("padding-left: 0");
  });
});
