// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import MobileDock from "@/components/mobile/MobileDock";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

afterEach(() => cleanup());

describe("MobileDock route contract", () => {
  it("renders five directly navigable slots and no menu sheet", () => {
    render(<MobileDock menus={[]} ready failed={false} canApprove={false} />);

    for (const [label, href] of [["工作台", "/dashboard"], ["项目", "/projects"], ["资产", "/assets"], ["报表", "/reports"]]) {
      const link = screen.getByRole("link", { name: label });
      expect(link.getAttribute("href")).toBe(href);
      expect(link.hasAttribute("aria-haspopup")).toBe(false);
      expect(link.hasAttribute("aria-expanded")).toBe(false);
    }
    expect(screen.queryByRole("dialog")).toBeNull();

    const mine = screen.getByRole("link", { name: "我的" });
    expect(mine.getAttribute("href")).toBe("/change-password");
    expect(mine.getAttribute("aria-haspopup")).toBe("dialog");
    expect(mine.getAttribute("aria-expanded")).toBe("false");
  });
});
