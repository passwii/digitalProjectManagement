import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const shellCss = readFileSync(
  resolve(process.cwd(), "components/av/AvShell.module.css"),
  "utf8",
);

const hoverContracts = [
  {
    selector: ".navLink:hover",
    pattern: /\.navLink:hover\s*\{[^}]*text-decoration:\s*none\s*;/,
  },
  {
    selector: ".brand:hover",
    pattern: /\.brand:hover\s*\{[^}]*text-decoration:\s*none\s*;/,
  },
  {
    selector: ".backLink:hover",
    pattern: /\.backLink:hover\s*\{[^}]*text-decoration:\s*none\s*;/,
  },
] as const;

describe("AV 侧栏链接 hover 样式契约", () => {
  it.each(hoverContracts)(
    "$selector 明确关闭全局 hover 下划线",
    ({ pattern }: { selector: string; pattern: RegExp }) => {
      expect(shellCss).toMatch(pattern);
    },
  );
});
