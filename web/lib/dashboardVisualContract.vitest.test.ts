import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dashboardCss = readFileSync(resolve(process.cwd(), "app/(dashboard)/dashboard/dashboard.module.css"), "utf8");
const readoutCss = readFileSync(resolve(process.cwd(), "components/dashboard/DashboardReadout.module.css"), "utf8");
const routeCss = readFileSync(resolve(process.cwd(), "components/dashboard/DashboardRouteField.module.css"), "utf8");
const queueCss = readFileSync(resolve(process.cwd(), "components/dashboard/DashboardInterventionQueue.module.css"), "utf8");
const dashboardStyles = [dashboardCss, readoutCss, routeCss, queueCss].join("\n");

function cssBlock(source: string, selector: string): string | null {
  let searchFrom = 0;
  let exactResult: string | null = null;
  let groupedResult: string | null = null;
  while (searchFrom < source.length) {
    const openingBrace = source.indexOf("{", searchFrom);
    if (openingBrace < 0) break;
    const boundary = Math.max(source.lastIndexOf("}", openingBrace - 1), source.lastIndexOf("{", openingBrace - 1));
    const header = source.slice(boundary + 1, openingBrace).replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const selectors = header.split(",").map((part) => part.trim());

    if (header === selector || selectors.includes(selector)) {
      let depth = 0;
      for (let index = openingBrace; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") {
          depth -= 1;
          if (depth === 0) {
            const block = source.slice(boundary + 1, index + 1);
            if (selectors.length === 1 && selectors[0] === selector) exactResult ??= block;
            else groupedResult = block;
            break;
          }
        }
      }
    }
    searchFrom = openingBrace + 1;
  }
  return exactResult ?? groupedResult;
}

describe("Dashboard graphite visual contract", () => {
  it("uses blue for primary actions and crisp inset edges for panels and readouts", () => {
    const approval = cssBlock(dashboardCss, ".approvalButton");
    const zone = cssBlock(dashboardCss, ".zone");
    const readout = cssBlock(readoutCss, ".readout");

    expect(approval).not.toBeNull();
    expect(approval).toContain("background: var(--brand);");
    expect(approval).toContain("color: var(--on-brand);");
    expect(approval).not.toContain("var(--action)");
    expect(zone).toContain("box-shadow: inset 0 1px 0 var(--highlight-inset);");
    expect(readout).toContain("--readout-signal: var(--dash-blue);");
    expect(readout).toContain("box-shadow: inset 0 1px 0 var(--highlight-inset);");
    expect(dashboardStyles).not.toMatch(/--dash-(?:lime|violet|magenta|aqua|data-green)\b/);
    expect(cssBlock(dashboardCss, ".dashboard")).toContain("--dash-cyan: var(--dash-mint);");
  });

  it("assigns route, queue, spend, and subject colors by semantic role", () => {
    expect(cssBlock(routeCss, ".ok")).toContain("--route-signal: var(--dash-success);");
    expect(cssBlock(routeCss, ".risk")).toContain("--route-signal: var(--dash-amber);");
    expect(cssBlock(routeCss, ".bad")).toContain("--route-signal: var(--dash-alert);");
    expect(cssBlock(queueCss, ".warn")).toContain("--queue-signal: var(--dash-amber);");
    expect(cssBlock(queueCss, ".danger")).toContain("--queue-signal: var(--dash-alert);");
    expect(cssBlock(readoutCss, ".warn")).toContain("--readout-signal: var(--dash-amber);");
    expect(cssBlock(readoutCss, ".danger")).toContain("--readout-signal: var(--dash-alert);");
    expect(cssBlock(readoutCss, ".done")).toContain("--readout-signal: var(--dash-success);");
    expect(cssBlock(dashboardCss, ".cyan")).toContain("--subject-signal: var(--dash-blue);");
    expect(cssBlock(dashboardCss, ".blue")).toContain("--subject-signal: var(--dash-mint);");
    expect(cssBlock(dashboardCss, ".violet")).toContain("--subject-signal: var(--dash-amber);");
    expect(cssBlock(dashboardCss, ".magenta")).toContain("--subject-signal: var(--dash-rose);");
    const spendLine = cssBlock(
      dashboardCss,
      ".chart :global(.recharts-line-curve),\n.chart :global(.recharts-line-dot)",
    );
    expect(spendLine).not.toBeNull();
    expect(spendLine).toContain("stroke: var(--dash-mint);");
  });

  it("keeps the readout rail in two columns at phone widths", () => {
    const narrowLayout = cssBlock(dashboardCss, "@media (max-width: 640px)");

    expect(narrowLayout).toContain(".readoutRail { grid-template-columns: repeat(2, minmax(0, 1fr)); }");
    expect(cssBlock(routeCss, ".route::before")).toContain("width: 1px;");
    expect(cssBlock(queueCss, ".pin")).toContain("width: 1px;");
  });

  it("keeps project identity, status, progress, and metadata aligned on phones", () => {
    const compactRoute = cssBlock(routeCss, "@media (max-width: 640px)");

    expect(cssBlock(routeCss, ".identity")).toContain("min-width: 0;");
    expect(cssBlock(routeCss, ".state")).toContain("flex: none;");
    expect(cssBlock(routeCss, ".trackLine")).toContain("display: flex;");
    expect(cssBlock(routeCss, ".track")).toContain("flex: 1;");
    expect(cssBlock(routeCss, ".progressValue")).toContain("text-align: right;");
    expect(cssBlock(routeCss, ".meta")).toContain("flex-wrap: wrap;");
    expect(compactRoute).toContain(".meta { gap: 8px; font-size: 10px; }");
  });

  it("avoids decorative gradient washes, glow shadows, and hardcoded colors", () => {
    expect(dashboardStyles).not.toMatch(/(?:radial|linear)-gradient\s*\(/);
    const shadows = Array.from(dashboardStyles.matchAll(/box-shadow:\s*([^;]+);/g), ([, value]) => value.trim())
      .filter((value) => value !== "none");
    expect(shadows.length).toBeGreaterThan(0);
    expect(shadows.every((value) => value === "inset 0 1px 0 var(--highlight-inset)")).toBe(true);
    expect(dashboardStyles).not.toMatch(/(?:animation|animation-iteration-count)[^;]*\binfinite\b/i);
    expect(dashboardStyles).not.toMatch(/#[\da-f]{3,8}\b|\brgba?\s*\(/i);
  });
});
