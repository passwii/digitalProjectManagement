// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import BottomSheet from "../components/mobile/BottomSheet";

const css = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../components/mobile/BottomSheet.module.css",
  ),
  "utf8",
);

describe("Dock 单档面板", () => {
  it("固定为单档，正文交给浏览器纵向滚动", () => {
    expect(css).toMatch(/height:\s*min\(78dvh/);
    expect(css).toMatch(/\.body\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.body\s*\{[^}]*touch-action:\s*pan-y/);
    expect(css).not.toMatch(/data-sheet="peek"|data-sheet="half"|data-sheet="full"/);
  });

  it("一次打开就有完整正文、关闭按钮与模态语义", () => {
    const onClose = vi.fn();
    const ui = render(
      <BottomSheet open onClose={onClose} title="项目" action={<a href="/projects">进入台账</a>}>
        <a href="/projects/1">项目 A</a>
      </BottomSheet>,
    );
    try {
      const panel = screen.getByRole("dialog", { name: "项目" });
      expect(panel.getAttribute("aria-modal")).toBe("true");
      expect(panel.getAttribute("data-sheet")).toBe("panel");
      expect(screen.getByText("项目 A")).toBeTruthy();
      expect(screen.getByText("进入台账")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "关闭项目面板" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      ui.unmount();
      cleanup();
    }
  });
});
