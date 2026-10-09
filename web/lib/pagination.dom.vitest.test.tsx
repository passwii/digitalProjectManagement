// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Pagination from "../components/ui/Pagination";

afterEach(() => cleanup());

describe("Pagination responsive structure", () => {
  it("keeps only previous/next controls and a compact page-size selector", () => {
    const onChange = vi.fn();
    const { container } = render(
      <Pagination page={2} size={15} total={90} onChange={onChange} sizeOptions={[15, 50, 100]} />,
    );
    const css = readFileSync(resolve(process.cwd(), "components/ui/Pagination.module.css"), "utf8");

    expect(screen.getByRole("button", { name: "上一页" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "下一页" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "首页" })).toBeNull();
    expect(screen.queryByRole("button", { name: "末页" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "每页条数" })).toBeTruthy();
    expect(css).toMatch(/\.size\s*\{[^}]*max-width:\s*110px/s);

    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(onChange).toHaveBeenCalledWith({ page: 1, size: 15 });
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(onChange).toHaveBeenCalledWith({ page: 3, size: 15 });

    const pagination = container.querySelector("nav");
    const controls = container.querySelector("nav > div");
    expect(pagination).not.toBeNull();
    expect(controls).not.toBeNull();
    expect(controls?.className).toContain("right");
    expect(css).toMatch(/\.right\s*\{[^}]*flex-wrap:\s*nowrap/s);
    expect(css).toMatch(/\.right\s*\{[^}]*max-width:\s*100%/s);
  });

  it("disables previous and next at their respective page boundaries", () => {
    const { rerender } = render(
      <Pagination page={1} size={15} total={30} onChange={vi.fn()} sizeOptions={[15, 50]} />,
    );
    expect(screen.getByRole("button", { name: "上一页" }).hasAttribute("disabled")).toBe(true);

    rerender(<Pagination page={2} size={15} total={30} onChange={vi.fn()} sizeOptions={[15, 50]} />);
    expect(screen.getByRole("button", { name: "下一页" }).hasAttribute("disabled")).toBe(true);
  });
});
