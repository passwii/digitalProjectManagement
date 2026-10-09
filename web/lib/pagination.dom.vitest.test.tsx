// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Pagination from "../components/ui/Pagination";

afterEach(() => cleanup());

describe("Pagination responsive structure", () => {
  it("allows the controls to wrap inside the pagination boundary", () => {
    const { container } = render(
      <Pagination page={2} size={15} total={90} onChange={vi.fn()} sizeOptions={[15, 50, 100]} />,
    );

    const pagination = container.querySelector("nav");
    const controls = container.querySelector("nav > div");

    const css = readFileSync(resolve(process.cwd(), "components/ui/Pagination.module.css"), "utf8");

    expect(pagination).not.toBeNull();
    expect(controls).not.toBeNull();
    expect(pagination?.className).toContain("wrap");
    expect(controls?.className).toContain("right");
    expect(css).toMatch(/\.right\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(css).toMatch(/\.right\s*\{[^}]*max-width:\s*100%/s);
    expect(screen.getByRole("button", { name: "上一页" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "下一页" })).toBeTruthy();
  });
});
