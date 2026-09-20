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
    expect(styles).toContain("max-width: min(34vw, 360px)");
    expect(styles).toContain("max-width: none");
  });
});
