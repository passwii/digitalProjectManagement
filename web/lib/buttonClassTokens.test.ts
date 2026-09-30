import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

/**
 * 按钮 class 的基础类守卫。
 *
 * 背景：`globals.css` 里只有 `.btn-primary` / `.btn-ghost` / `.btn-danger` /
 * `.btn-icon` 是**基础类**，它们负责 display / 内边距 / 高度 / 背景 / 描边 / 圆角。
 * `.btn-xs`、`.btn-danger-outline`、`.danger-link` 都是**修饰类**，只覆写其中一两项
 * （`.btn-danger-outline` 只改 color 与 border-color，`.btn-xs` 只改尺寸）。
 *
 * 所以只写修饰类 = 拿到一个浏览器默认样式的原生 <button>。finance 页「移入回收站」
 * 就是这么坏掉的：一排 `btn-ghost` 中间夹了一个孤零零的 `btn-danger-outline`，
 * 它比兄弟按钮矮一截、白底方角，一眼就能看出来。同一个根因在 finance 模块里
 * 一共有 9 处，全靠人工翻页面才发现——加这条守卫，别再靠肉眼。
 *
 * `danger-link` 只是文字色工具类，不属于按钮结构，故不在检查范围内。
 */

const BASE_CLASSES = ["btn-primary", "btn-ghost", "btn-danger", "btn-icon"];
const MODIFIER_CLASSES = ["btn-xs", "btn-danger-outline"];
const SCAN_ROOTS = ["app", "components", "lib"];
const SCAN_EXTENSIONS = [".ts", ".tsx"];

/** 抓 `className="…"`、`className={"…"}`、className={`…`}` 与对象字面量的 `className: "…"`。 */
const CLASS_NAME_VALUE = /className\s*[=:]\s*\{?\s*(?:"([^"]*)"|`([^`]*)`)/g;

/**
 * 把一段 class 字符串切成 token。模板插值（`` `btn-xs ${x ? "btn-primary" : ""}` ``）
 * 里的候选类名也必须被看见，所以分隔符里带上 `${}?:()[]"'`` 这些语法字符。
 */
function tokensOf(classValue: string): Set<string> {
  return new Set(classValue.split(/[\s$`{}?:()[\],"']+/).filter(Boolean));
}

/** 手写递归而不是 `readdirSync(..., { recursive: true })`：后者的 `parentPath`
 *  要 Node 20.12+ 才有，CI 只钉了 `node-version: "20"`，不吃这个假设。 */
function sourceFiles(relativeDir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(resolve(process.cwd(), relativeDir), { withFileTypes: true })) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...sourceFiles(relativePath));
    } else if (SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(resolve(process.cwd(), relativePath));
    }
  }
  return found;
}

function violationsIn(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of text.matchAll(CLASS_NAME_VALUE)) {
    const classValue = match[1] ?? match[2] ?? "";
    const tokens = tokensOf(classValue);
    const modifiers = MODIFIER_CLASSES.filter((name) => tokens.has(name));
    if (!modifiers.length) continue;
    if (BASE_CLASSES.some((name) => tokens.has(name))) continue;
    const line = text.slice(0, match.index).split("\n").length;
    found.push(`${file.replace(`${process.cwd()}/`, "")}:${line} 只用了修饰类 ${modifiers.join(" + ")}`);
  }
  return found;
}

describe("按钮 class 基础类", () => {
  it("只有修饰类（btn-xs / btn-danger-outline）的按钮不存在", () => {
    const violations = SCAN_ROOTS.flatMap(sourceFiles).flatMap(violationsIn).sort();

    assert.deepEqual(
      violations,
      [],
      `以下按钮缺少基础类，会渲染成浏览器默认样式的原生按钮。` +
        `请从 ${BASE_CLASSES.join(" / ")} 里补一个（例如 btn-ghost btn-xs btn-danger-outline）：\n` +
        violations.join("\n"),
    );
  });
});
