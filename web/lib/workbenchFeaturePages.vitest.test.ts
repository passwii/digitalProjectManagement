import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const assets = readFileSync(resolve(root, "app/(dashboard)/assets/assets.css"), "utf8");
const finance = readFileSync(resolve(root, "app/(dashboard)/finance/finance.module.css"), "utf8");
const receivables = readFileSync(resolve(root, "app/(dashboard)/projects/[id]/ProjectReceivables.module.css"), "utf8");
const changelog = readFileSync(resolve(root, "app/(dashboard)/changelog/changelog.module.css"), "utf8");
const datePicker = readFileSync(resolve(root, "app/(dashboard)/dev/date-picker/date-picker.module.css"), "utf8");

function ruleBody(source: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "s"));
  expect(match, `Missing CSS rule for ${selector}`).toBeTruthy();
  return match?.[1] ?? "";
}

const insetEdge = /box-shadow:\s*inset 0 1px 0 var\(--highlight-inset\)/;

describe("graphite workbench feature page surfaces", () => {
  it("keeps asset panels and date-picker examples on bordered inset surfaces", () => {
    expect(ruleBody(assets, ".asset-panel")).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(ruleBody(assets, ".asset-panel")).toMatch(insetEdge);
    expect(ruleBody(datePicker, ".compare")).toMatch(insetEdge);
    expect(ruleBody(datePicker, ".row")).toMatch(insetEdge);
  });

  it("frames mobile receivable payment details without adding outer elevation", () => {
    const body = ruleBody(receivables, ".paymentMobile");
    expect(body).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(body).toMatch(insetEdge);
    expect(body).not.toMatch(/box-shadow:\s*var\(--shadow-card\)/);
  });

  it("right-aligns finance amounts and uses tabular figures", () => {
    const body = ruleBody(finance, ".scrollTable :global(.num)");
    expect(body).toMatch(/text-align:\s*right/);
    expect(body).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it("keeps the latest changelog marker crisp and entry hover stationary", () => {
    expect(ruleBody(changelog, ".dayLatest .node")).toMatch(/outline:\s*\d+px solid var\(--line-blue\)/);
    expect(changelog).not.toMatch(/box-shadow:\s*0\s+0\s+0\s+4px var\(--brand-soft\)/);
    expect(changelog).not.toMatch(/transform:\s*translateX\(/);
  });
});
