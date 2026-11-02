// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { getWorkbenchPortalContainer } from "./workbenchPortalContainer";

const portalCallSites = [
  { file: "components/ui/Modal.tsx", portals: 3 },
  { file: "components/ui/Select.tsx", portals: 1 },
  { file: "components/mobile/BottomSheet.tsx", portals: 1 },
  { file: "components/pwa/InstallPrompt.tsx", portals: 1 },
] as const;

type PortalSource = { file: string; source: string };
type PortalCall = { file: string; call: ts.CallExpression; sourceFile: ts.SourceFile };

function readPortalSources(): PortalSource[] {
  return portalCallSites.map(({ file }) => ({
    file,
    source: readFileSync(resolve(process.cwd(), file), "utf8"),
  }));
}

function findPortalCalls(sources: PortalSource[]): PortalCall[] {
  const portalCalls: PortalCall[] = [];
  for (const { file, source } of sources) {
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "createPortal"
      ) {
        portalCalls.push({ file, call: node, sourceFile });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return portalCalls;
}

function isWorkbenchPortalCall(expression: ts.Expression | undefined): boolean {
  return Boolean(
    expression
    && ts.isCallExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === "getWorkbenchPortalContainer"
    && expression.arguments.length === 0,
  );
}

function nearestBlock(node: ts.Node): ts.Node | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) return current;
  }
  return undefined;
}

function isWorkbenchPortalTarget({ call, sourceFile }: PortalCall): boolean {
  const target = call.arguments[1];
  if (isWorkbenchPortalCall(target)) return true;
  if (!target || !ts.isIdentifier(target)) return false;

  const callBlock = nearestBlock(call);
  let resolvesToHelper = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === target.text
      && nearestBlock(node) === callBlock
      && isWorkbenchPortalCall(node.initializer)
    ) {
      resolvesToHelper = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return resolvesToHelper;
}

function hasExpectedPortalCounts(calls: PortalCall[]): boolean {
  return calls.length === 6 && portalCallSites.every(({ file, portals }) => {
    const fileCount = calls.filter((call) => call.file === file).length;
    return fileCount === portals;
  });
}

function portalContractSatisfied(sources: PortalSource[]): boolean {
  const calls = findPortalCalls(sources);
  return hasExpectedPortalCounts(calls) && calls.every(isWorkbenchPortalTarget);
}

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
    const sources = readPortalSources();
    const calls = findPortalCalls(sources);
    expect(calls).toHaveLength(6);
    for (const { file, portals } of portalCallSites) {
      expect(calls.filter((call) => call.file === file)).toHaveLength(portals);
    }
    expect(calls.every(isWorkbenchPortalTarget)).toBe(true);
    expect(portalContractSatisfied(sources)).toBe(true);
  });

  it("rejects a document.body target even when a helper reference remains elsewhere", () => {
    const sources = readPortalSources();
    const select = sources.find(({ file }) => file === "components/ui/Select.tsx");
    if (!select) throw new Error("Select portal source is missing");
    const mutatedSource = select.source.replace("getWorkbenchPortalContainer(),", "document.body,");
    expect(mutatedSource).not.toBe(select.source);

    const mutatedSources = sources.map((item) => item.file === select.file
      ? { ...item, source: `${mutatedSource}\ngetWorkbenchPortalContainer();` }
      : item);

    expect(portalContractSatisfied(mutatedSources)).toBe(false);
  });
});
