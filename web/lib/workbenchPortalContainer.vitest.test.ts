// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getWorkbenchPortalContainer } from "./workbenchPortalContainer";

const portalCallSites = [
  { file: "components/ui/Modal.tsx", portals: 3 },
  { file: "components/ui/Select.tsx", portals: 1 },
  { file: "components/mobile/BottomSheet.tsx", portals: 1 },
  { file: "components/pwa/InstallPrompt.tsx", portals: 1 },
] as const;

afterEach(() => {
  document.body.replaceChildren();
});

describe("getWorkbenchPortalContainer", () => {
  it("selects the authenticated console shell when it exists", () => {
    const isolatedShell = document.createElement("div");
    isolatedShell.className = "shell";
    isolatedShell.dataset.consoleShell = "false";

    const consoleShell = document.createElement("div");
    consoleShell.className = "Shell_shell__runtimeHash";
    consoleShell.dataset.consoleShell = "true";
    document.body.append(isolatedShell, consoleShell);

    expect(getWorkbenchPortalContainer()).toBe(consoleShell);
  });

  it("falls back to document.body when the authenticated shell is absent", () => {
    const isolatedShell = document.createElement("div");
    isolatedShell.className = "shell";
    isolatedShell.dataset.consoleShell = "false";
    document.body.append(isolatedShell);

    expect(getWorkbenchPortalContainer()).toBe(document.body);
  });

  it("routes every shared overlay portal through the shell-aware helper", () => {
    for (const { file, portals } of portalCallSites) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      const portalCount = source.match(/createPortal\s*\(/g)?.length ?? 0;
      const helperTargetCount = source.match(/getWorkbenchPortalContainer\s*\(\s*\)/g)?.length ?? 0;

      expect(portalCount, `${file} portal count`).toBe(portals);
      expect(helperTargetCount, `${file} helper target count`).toBe(portals);
    }
  });
});
