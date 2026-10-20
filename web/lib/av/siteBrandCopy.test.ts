import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { AV_BASE_PATH, AV_PAGES } from "./navigation";

/**
 * BLF-1397：站点品牌中文化契约。
 *
 * 访客第一眼看到的是品牌名。BLF-1387 时站点的可见名称是英文「Stream Monitor」，
 * 本轮换成中文「智能音视频平台」，**URL 仍然保留 `/stream-monitor`** ——
 * 路径是稳定契约（链接、书签、兼容重定向都指着它），品牌名不是。
 *
 * 守三件事：
 *   1. 用户可见位置**不再出现**英文品牌 `Stream Monitor` / `STREAM MONITOR`；
 *   2. 用户可见位置**确实出现**中文品牌「智能音视频平台」（不是把品牌删了事）；
 *   3. URL 前缀仍是 `/stream-monitor`，内部标识符（`AV_PAGES` 等）一动不动。
 *
 * ⚠️ 与 `lib/siteCopyGuard.test.ts` 的分工：那边守**措辞**（mock / 工程术语 / 内部口径），
 * 这边守**品牌**。两处不重叠。
 */

/** 递归列出目录下所有 .ts / .tsx 源文件。 */
function filesUnder(dir: string, extension: RegExp): string[] {
  const root = resolve(process.cwd(), dir);
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (extension.test(entry.name)) out.push(path);
    }
  };
  walk(root);
  return out;
}

/**
 * 遮蔽注释，但**保留字符串内容**。
 *
 * 用词法状态机而不是「行首 //」正则：后者会把字符串里的两个斜杠当成注释开头，
 * 从那儿截断整行，后面真正含违禁词的字符串就漏扫了。
 */
function maskComments(text: string): string {
  type State = "code" | "line" | "block" | "single" | "double" | "template";
  let state: State = "code";
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        out += "  ";
        index += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        out += "  ";
        index += 1;
        continue;
      }
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
      out += char;
      continue;
    }
    if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += "\n";
      } else {
        out += " ";
      }
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        out += "  ";
        index += 1;
      } else {
        out += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
    if (char === "\\") {
      out += char + (next ?? "");
      index += 1;
      continue;
    }
    if (char === quote) state = "code";
    out += char;
  }
  return out;
}

/** 站点用户可见文案所在的目录。 */
const SITE_DIRS = ["app/stream-monitor", "components/av"];

/** 站点目录之外、但用户可见的单文件。 */
const SITE_EXTRA_FILES = [
  // 主工作台侧栏的站点入口（品牌名）
  "app/(dashboard)/layout.tsx",
];

/** 公开静态数据集（访客可直接下载）。 */
const PUBLIC_DATA_DIR = "public/stream-monitor-data";

const SITE_FILES = [
  ...SITE_DIRS.flatMap((dir) => filesUnder(dir, /\.tsx?$/)).filter(
    (file) => !/\.test\.ts$/.test(file),
  ),
  ...SITE_EXTRA_FILES.map((file) => resolve(process.cwd(), file)),
];

const PUBLIC_DATA_FILES = filesUnder(PUBLIC_DATA_DIR, /\.json$/);

/**
 * 英文品牌残留。
 *
 * 只拦**展示性**字样：站点名出现成 `Stream Monitor` / `STREAM MONITOR`。
 * 路径 `/stream-monitor`（小写连字符）不受影响 —— 那是 URL 契约。
 */
const ENGLISH_BRAND = [/Stream Monitor/, /STREAM MONITOR/];

/** 命中位置：文件 + 行号 + 命中片段。 */
interface Offender {
  file: string;
  line: number;
  snippet: string;
}

function scan(file: string): Offender[] {
  const source = maskComments(readFileSync(file, "utf8"));
  const offenders: Offender[] = [];
  source.split("\n").forEach((line, offset) => {
    for (const pattern of ENGLISH_BRAND) {
      if (!pattern.test(line)) continue;
      offenders.push({ file, line: offset + 1, snippet: line.trim().slice(0, 120) });
      break;
    }
  });
  return offenders;
}

describe("站点品牌中文化（BLF-1397）", () => {
  it("用户可见位置不再出现英文品牌 Stream Monitor", () => {
    const offenders: Offender[] = [];
    for (const file of SITE_FILES) offenders.push(...scan(file));
    assert.deepEqual(
      offenders.map((item) => `${item.file}:${item.line}: ${item.snippet}`),
      [],
    );
  });

  it("公开可下载的数据集里也没有英文品牌", () => {
    // org.json 的 name / shortName / copyright 会被访客直接看到。
    const offenders: Offender[] = [];
    for (const file of PUBLIC_DATA_FILES) offenders.push(...scan(file));
    assert.deepEqual(
      offenders.map((item) => `${item.file}:${item.line}: ${item.snippet}`),
      [],
    );
  });

  it("中文品牌确实出现在用户可见位置（不是把品牌删了事）", () => {
    const shell = readFileSync(resolve(process.cwd(), "components/av/AvShell.tsx"), "utf8");
    assert.match(shell, /智能音视频平台/);
    const desktop = readFileSync(resolve(process.cwd(), "app/(dashboard)/layout.tsx"), "utf8");
    assert.match(desktop, /"\/stream-monitor": "智能音视频平台"/);
  });

  it("URL 前缀仍然是 /stream-monitor（品牌中文化不改路径）", () => {
    assert.equal(AV_BASE_PATH, "/stream-monitor");
    for (const page of AV_PAGES) {
      assert.ok(page.href.startsWith("/stream-monitor/"), `${page.href} 不在 /stream-monitor 下`);
    }
  });

  it("品牌守卫不是空跑（用样本字符串自证）", () => {
    const sample = 'const brand = "Stream Monitor";';
    assert.ok(ENGLISH_BRAND.some((pattern) => pattern.test(sample)));
    // 路径（小写连字符）不该被误伤
    const pathSample = 'const href = "/stream-monitor/overview";';
    assert.equal(ENGLISH_BRAND.some((pattern) => pattern.test(pathSample)), false);
  });
});
