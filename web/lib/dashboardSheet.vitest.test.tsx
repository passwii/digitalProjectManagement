// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("@/lib/useAsyncData", () => ({
  useAsyncData: () => ({
    data: {
      summary: { kpi: {
        unread_notifications: 0,
        pending_approvals: 0,
        my_overdue_tasks: 0,
        overdue_tasks: 0,
        near_milestones: 0,
        month: "2026-09",
        month_spent: 0,
      } },
    },
    firstLoad: false,
    error: null,
    reload: vi.fn(),
  }),
}));

import DashboardSheet from "@/components/mobile/sheets/DashboardSheet";

afterEach(cleanup);

describe("DashboardSheet navigation", () => {
  it("removes progress shortcuts while keeping the reports expense KPI and no asset shortcut", () => {
    const { container } = render(
      <DashboardSheet
        onSelect={vi.fn()}
        item={{
          id: "dashboard", label: "工作台", href: "/dashboard", keys: [], hrefs: ["/dashboard"],
          visible: [],
        }}
        ready
        failed={false}
        canApprove={false}
      />,
    );
    const hrefs = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(hrefs).not.toContain("/progress");
    expect(hrefs).not.toContain("/assets");
    expect(hrefs).toContain("/reports");
  });
});
