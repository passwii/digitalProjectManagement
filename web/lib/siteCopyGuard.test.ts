import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

/**
 * BLF-1388：生产介绍站点（`/spark` 云电竞管理平台、`/stream-monitor` Stream Monitor）
 * 不得再出现 mock / 演示 / 虚假 一类措辞。
 *
 * 这两个站点对外做产品介绍，文案必须准确、中性：不能把静态数据集说成实时生产数据，
 * 也不能用「演示 / mock / 虚假」把自己写小。BLF-1388 之前它们到处挂着「本地 Mock」
 * 徽标、「模拟事件与告警」面板标题、门禁上的「DEMO · 本地校验」—— 靠人肉检查守不住，
 * 所以让 CI 守。
 *
 * 守什么：
 *   · 两个站点的**用户可见文案**里不出现 mock / Mock / 演示 / 虚假 / 假数据 / 模拟 /
 *     demo / fake 这类措辞（含 JSX 文本、字符串字面量、title / aria-label / description）。
 *
 * 不守什么（刻意放行）：
 *   · **技术标识符与路径**：`/mock/av` 数据目录、`spark-demo` 浏览上下文名 —— 这些不显示
 *     给用户，重命名会牵动 fixtures、脚本与契约测试（BLF-1387 已经明确不做无谓重命名）；
 *   · **注释**：注释里的技术说明是给维护者看的知识，不是产品文案；
 *   · **主工作台**的 `demo_data_on` 演示数据开关 —— 它是真实业务能力（管理端数据开关），
 *     文案必须保留真实含义，不在本 issue 的清理范围内。
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
function maskComments(source: string): string {
  type State = "code" | "line" | "block" | "single" | "double" | "template";
  let state: State = "code";
  let out = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
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

/** 违禁措辞。英文用词边界，避免 `democratize` 这类无关词误伤。 */
const FORBIDDEN: RegExp[] = [
  /\bmock\b/i,
  /\bdemo\b/i,
  /\bfake\b/i,
  /演示/,
  /虚假/,
  /假数据/,
  /伪造/,
  /模拟/,
];

/**
 * 逐条放行的技术标识符（不显示给用户）。
 *
 * 每条都要写清「为什么可以放行」，否则后来的人只会往上加，白名单就烂了。
 */
const ALLOWED: { file: string; contains: string; why: string }[] = [
  {
    file: "lib/spark/navigation.ts",
    contains: "spark-demo",
    why: "浏览上下文名（window target），只出现在 DOM 属性与链接 target 上，不作为文案显示",
  },
  {
    file: "lib/av/load.ts",
    contains: "/mock/av",
    why: "数据集目录路径（public/mock/av），属于 fixture 技术路径，不显示给用户",
  },
  {
    file: "lib/av/server.ts",
    contains: "public/mock/av",
    why: "数据集目录路径（public/mock/av），属于 fixture 技术路径，不显示给用户",
  },
  {
    file: "lib/av/server.ts",
    contains: "../web/public/mock/av",
    why: "数据集目录路径的另一种相对写法，仍是 fixture 技术路径",
  },
  {
    file: "lib/av/server.ts",
    contains: "找不到 AV mock 数据目录",
    why: "服务端启动期的诊断异常文案，面向开发者排障，不在任何页面上展示",
  },
];

/** 站点目录：两个生产介绍站点的全部用户可见页面与组件。 */
const SITE_DIRS = [
  "app/spark",
  "app/stream-monitor",
  "components/spark",
  "components/av",
  "lib/spark",
  "lib/av",
];

const SITE_FILES = SITE_DIRS.flatMap((dir) => filesUnder(dir, /\.tsx?$/)).filter(
  (file) => !/\.test\.ts$/.test(file),
);

/** 命中位置：文件 + 行号 + 命中片段。 */
interface Offender {
  file: string;
  line: number;
  snippet: string;
}

function scan(file: string): Offender[] {
  const source = maskComments(readFileSync(file, "utf8"));
  const offenders: Offender[] = [];
  const lines = source.split("\n");
  lines.forEach((line, offset) => {
    for (const pattern of FORBIDDEN) {
      const match = pattern.exec(line);
      if (!match) continue;
      const snippet = line.trim().slice(0, 120);
      // 白名单：命中片段包含被放行的技术标识符 → 跳过这一行。
      const relative = file.slice(resolve(process.cwd()).length + 1);
      const allowed = ALLOWED.some(
        (entry) => entry.file === relative && snippet.includes(entry.contains),
      );
      if (allowed) continue;
      offenders.push({ file, line: offset + 1, snippet });
    }
  });
  return offenders;
}

describe("生产介绍站点文案：不得出现 mock / 演示措辞（BLF-1388）", () => {
  it("两个站点的用户可见文案里没有 mock / 演示 / 虚假类措辞", () => {
    const offenders: Offender[] = [];
    for (const file of SITE_FILES) offenders.push(...scan(file));
    assert.deepEqual(
      offenders.map((item) => `${item.file}:${item.line}: ${item.snippet}`),
      [],
    );
  });

  it("扫到了东西（守卫生效，不是空跑）", () => {
    // 白名单写太宽会让上面的用例变成永远绿的空跑。这里用两个已知含违禁词的样本
    // 直接验证扫描逻辑本身。
    const sample = 'const label = "本地 Mock 数据"; // 注释里的 mock 不算\n';
    const masked = maskComments(sample);
    const hits = FORBIDDEN.filter((pattern) => pattern.test(masked.split("\n")[0]));
    assert.equal(hits.length, 1);
    // 注释被遮蔽后不参与匹配
    assert.equal(FORBIDDEN.some((pattern) => pattern.test(masked.split("\n")[1])), false);
  });

  it("白名单只放行技术标识符，且每条都写明理由", () => {
    const relativePaths = SITE_FILES.map((file) => file.slice(resolve(process.cwd()).length + 1));
    for (const entry of ALLOWED) {
      assert.ok(entry.why.length > 0, `${entry.file} 的白名单条目必须写明放行理由`);
      assert.ok(
        relativePaths.includes(entry.file),
        `${entry.file} 的白名单条目指向了不存在的文件`,
      );
    }
  });

  it("主工作台的演示数据开关保留真实含义（不在本次清理范围内）", () => {
    // demo_data_on 是管理端真实业务能力（控制台账等页面是否显示演示数据），
    // 它的文案必须如实描述能力，不能为了「看起来干净」把功能藏起来。
    const admin = readFileSync(resolve(process.cwd(), "app/(dashboard)/admin/ParamDialog.tsx"), "utf8");
    assert.match(admin, /demo_data_on: "演示数据开关（0隐藏\/1显示）"/);
    assert.match(admin, /demo_data_on: "1=在项目台账等页面显示演示数据；0=全站隐藏（含工作台与报表统计）"/);
  });
});
