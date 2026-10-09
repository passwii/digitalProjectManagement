// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import MobileDock from "../components/mobile/MobileDock";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

afterEach(() => cleanup());

describe("MobileDock 直接导航", () => {
  it("模块位保留原路由链接，不要求先打开抽屉再确认", () => {
    render(<MobileDock menus={[]} ready failed={false} canApprove={false} />);

    const projects = screen.getByRole("link", { name: "项目" });
    expect(projects.getAttribute("href")).toBe("/projects");
    expect(projects.hasAttribute("aria-haspopup")).toBe(false);
    expect(projects.hasAttribute("aria-expanded")).toBe(false);
    expect(screen.getByRole("link", { name: "资产" }).getAttribute("href")).toBe("/assets");
    expect(screen.getByRole("link", { name: "报表" }).getAttribute("href")).toBe("/reports");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
