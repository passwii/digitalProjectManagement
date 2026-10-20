import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

/**
 * BLF-1387：音视频站点改名为 stream monitor 的品牌与路径契约。
 *
 * 这条契约守两件事：
 *   1. **用户可见的名称**统一为 "Stream Monitor"（壳层品牌、可访问名称、页面
 *      title / metadata、门禁浮层、工作台侧栏入口）；
 *   2. **公开路径**只有 `/stream-monitor` 一套，旧 `/av` 由 middleware 308 兼容
 *      重定向 —— 站点里不得再出现指向旧路径的链接（否则点了就是断链）。
 *
 * 刻意**不**守的东西：内部标识符（`AV_PAGES`、`--av-*` CSS 变量、`lib/av/`
 * 目录、fixture 文件名、API 契约字段）。那些不显示给用户，重命名会牵动
 * 大量无谓的改动，收益为零、风险为负。
 */

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

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
 * 去掉注释，只留代码。
 *
 * 为什么必须去：注释里写「旧路径已迁到 /stream-monitor」是**说明**，不是链接；
 * 不过滤的话，这条守卫会被注释里的历史路径误伤，最后只能靠删注释来过 ——
 * 那就把知识删掉了。
 *
 * 遮蔽注释但**保留字符串内容**（路径就写在字符串里）。这里用词法状态机，
 * 不用「行首 //」正则：后者会把字符串里的两个斜杠当成注释开头。
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

describe("Stream Monitor 品牌与路径契约（BLF-1387）", () => {
  const shell = source("components/av/AvShell.tsx");
  const gate = source("components/av/AvGate.tsx");
  const layout = source("app/stream-monitor/layout.tsx");
  const sectionPage = source("app/stream-monitor/[section]/page.tsx");
  const detailPage = source("app/stream-monitor/[section]/[id]/page.tsx");
  const audioPage = source("app/stream-monitor/audio/page.tsx");
  const stressPage = source("app/stream-monitor/%5F%5Fstress/page.tsx");
  const desktopLayout = source("app/(dashboard)/layout.tsx");
  const orgFixture = JSON.parse(source("public/mock/av/org.json")) as {
    name: string;
    shortName: string;
    copyright: string;
  };

  it("壳层的品牌与可访问名称统一为 Stream Monitor", () => {
    assert.match(shell, /aria-label="Stream Monitor 侧栏"/);
    assert.match(shell, /aria-label="关闭 Stream Monitor 导航"/);
    assert.match(shell, /aria-label="打开 Stream Monitor 导航"/);
    assert.match(shell, /aria-label="返回 Stream Monitor 总览"/);
    assert.match(shell, /aria-label="Stream Monitor 模块"/);
    assert.match(shell, /<small>STREAM MONITOR · \{version\}<\/small>/);
    // 旧名称不许再出现在用户可见的壳层文案里
    assert.doesNotMatch(shell, /智能音视频平台|AV PLATFORM/);
  });

  it("门禁浮层使用统一名称", () => {
    assert.match(gate, /Stream Monitor · 安全验证/);
    assert.match(gate, /<span>STREAM MONITOR CONSOLE<\/span>/);
    assert.doesNotMatch(gate, /智能音视频平台|MULTICA AV CONSOLE/);
  });

  it("页面 metadata 统一使用 Stream Monitor", () => {
    assert.match(layout, /title: "Stream Monitor"/);
    assert.match(sectionPage, /title: "Stream Monitor"/);
    assert.match(sectionPage, /`\$\{page\.label\} · Stream Monitor`/);
    assert.match(detailPage, /"Stream Monitor"/);
    assert.match(audioPage, /title: "音频分析 · Stream Monitor"/);
    assert.match(stressPage, /title: "布局压力测试 · Stream Monitor"/);
  });

  it("工作台侧栏入口使用统一名称与新路径", () => {
    assert.match(desktopLayout, /"\/stream-monitor": "Stream Monitor"/);
    assert.match(desktopLayout, /out\.push\(\{ href: "\/stream-monitor"/);
    assert.doesNotMatch(desktopLayout, /"\/av"/);
  });

  it("数据集的品牌字段使用统一名称", () => {
    assert.equal(orgFixture.name, "Stream Monitor");
    assert.equal(orgFixture.shortName, "Stream Monitor");
    assert.match(orgFixture.copyright, /Stream Monitor/);
  });

  it("站点内没有指向旧路径 /av 的链接（不留下断链）", () => {
    // 扫的是「用户可见的链接与路由」：app 目录、components/av 目录、lib/av 目录。
    // 旧路径只允许出现在 middleware 的兼容重定向里（由下面单独的用例守）。
    // 注释被遮蔽掉 —— 注释里的历史路径是说明，不是链接。
    const files = [
      ...filesUnder("app/stream-monitor", /\.tsx?$/),
      ...filesUnder("components/av", /\.tsx?$/),
      ...filesUnder("lib/av", /\.ts$/),
      // 测试文件本身要断言旧路径（兼容重定向的用例），它们不是「站点里的链接」
    ].filter((file) => !/\.test\.ts$/.test(file));
    const offenders: string[] = [];
    for (const file of files) {
      const text = maskComments(source(file));
      // 匹配 "/av" 或 "/av/" 开头的路径引用（模板串里的 ${base}/av 也算）。
      const matches = text.match(/["'`(\s]\/av(\/|["'`\s])/g);
      if (matches) offenders.push(`${file}: ${matches.join(", ")}`);
    }
    assert.deepEqual(offenders, []);
  });

  it("旧路径只在 middleware 的兼容重定向里出现（308 到位）", () => {
    const middleware = source("middleware.ts");
    assert.match(middleware, /const LEGACY_AV_PREFIX = "\/av"/);
    assert.match(middleware, /NextResponse\.redirect\(url, 308\)/);
    // 新路径同时在 PUBLIC_PATHS 与总览重定向里
    assert.match(middleware, /"\/stream-monitor"/);
    assert.match(middleware, /const SITE_HOME = "\/stream-monitor\/overview"/);
  });

  it("内部标识符与 fixture 路径保持不变（不做无谓重命名）", () => {
    // AV_PAGES / AV_HOME / AV_WINDOW_TARGET 是内部契约名
    assert.match(source("lib/av/navigation.ts"), /export const AV_PAGES/);
    // 数据目录仍是 public/mock/av（脚本 / 契约测试都按这个路径读）
    assert.match(source("lib/av/load.ts"), /"\/mock\/av"/);
    assert.match(source("lib/av/server.ts"), /public\/mock\/av/);
  });

  it("站点源文件里没有 UTF-8 替换字符（U+FFFD），改名前后的中文都没被写坏", () => {
    // 为什么守这个：改名时整批文件被重写，中文注释一旦在某一环被按错误编码
    // 解码再存回，U+FFFD 就会静默混进源码 —— 它是合法 UTF-8，git 不报错、
    // tsc 不报错、测试全绿，只有真正读那行注释的人会发现是乱码。
    // （BLF-1387 合并后实测：`streamMonitorBranding.test.ts` 的注释里就混进了一个。）
    //
    // 扫描范围必须覆盖**本次改名动过的全部文件**，不能只扫站点目录下的 .ts/.tsx：
    // 那次迁移同时改了 `app/(dashboard)/layout.tsx`（工作台侧栏入口与图标映射）、
    // `middleware.ts`（兼容重定向）、`public/mock/av/org.json`（品牌字段）、
    // `app/globals.css`（令牌段注释）和站点的 CSS module —— 它们的注释里同样
    // 有中文，坏在任何一个里都是同一个静默故障。扩展名也放宽到 .json/.css，
    // 免得以后新增文件类型时又漏掉。
    const files = [
      ...filesUnder("app/stream-monitor", /\.(tsx?|css|json)$/),
      ...filesUnder("components/av", /\.(tsx?|css|json)$/),
      ...filesUnder("lib/av", /\.(ts|json)$/),
      // 改名同时动过工作台壳层与 middleware（都在站点目录之外，但属于同一次迁移）
      "app/(dashboard)/layout.tsx",
      "middleware.ts",
      "public/mock/av/org.json",
      "app/globals.css",
    ];
    const offenders: string[] = [];
    for (const file of files) {
      if (source(file).includes("\uFFFD")) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });
});
