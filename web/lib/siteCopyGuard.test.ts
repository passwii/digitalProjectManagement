import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

/**
 * BLF-1388 / BLF-1394：生产介绍站点（`/spark` 云电竞管理平台、`/stream-monitor` Stream Monitor）
 * 不得再出现 mock / 演示 / 本地 / 模拟 一类把自己写小的措辞，也不得漏出工程内部术语。
 *
 * 这两个站点对外做产品介绍，文案必须准确、中性：不能把静态数据说成实时生产数据，
 * 也不能用「演示 / mock / 虚假」把自己写小。BLF-1388 之前它们到处挂着「本地 Mock」
 * 徽标、「模拟事件与告警」面板标题、门禁上的「DEMO · 本地校验」—— 靠人肉检查守不住，
 * 所以让 CI 守。
 *
 * 守什么：
 *   · 两个站点的**用户可见文案**里不出现 mock / Mock / 演示 / 虚假 / 假数据 / 模拟 /
 *     demo / fake 这类措辞（含 JSX 文本、字符串字面量、title / aria-label / description）。
 *   · **BLF-1394 起扩了两类**：
 *     ① 「把自己写小」的第二梯队 —— 本地 / 示例 / 样例 / 虚拟；
 *     ② **工程内部术语外泄** —— 分片 / 首屏 / 字段 / 数据集 / 布局回归 / 压力测试。
 *        这类词比 mock 更露怯：访客一看「首屏预算」「分片」「数据集」就知道这不是真实
 *        生产系统。
 *
 * 不守什么（刻意放行）：
 *   · **注释**：注释里的技术说明是给维护者看的知识，不是产品文案；
 *   · **主工作台**的 `demo_data_on` 演示数据开关 —— 它是真实业务能力（管理端数据开关），
 *     文案必须保留真实含义，不在本 issue 的清理范围内。
 *   · **地理含义的「本地」** —— 如「苏州本地赛事」：这里的「本地」是地理概念，与 mock 无关。
 *     这类合法文案由下面的反向用例守住（见「不误伤合法文案」用例）。
 *
 * 为什么不守「真实」：红线要求**不得把静态数据说成实时生产数据**，而「不产生真实资金交易」
 * 这类文案恰恰是诚实说明的一部分 —— 去掉它反而是撒谎。
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

/**
 * 违禁措辞。英文用词边界，避免 `democratize` 这类无关词误伤。
 *
 * 分三组：
 *   1. **把自己写小**：mock / demo / fake / 演示 / 虚假 / 假数据 / 伪造 / 模拟 /
 *      本地 / 示例 / 样例 / 虚拟；
 *   2. **工程内部术语外泄**（BLF-1394 新增）：分片 / 首屏 / 字段 / 数据集 /
 *      布局回归 / 压力测试；
 *   3. **旧品牌残留**（BLF-1394 新增）：NebulaCloud / nebulacloud。
 *
 * 「本地」在第 1 组里是有风险的：它可能是地理含义（「苏州本地赛事」，合法）。
 * 这类合法用法由白名单逐条放行（见 ALLOWED 的「地理含义」条目）与反向用例守住。
 */
const FORBIDDEN: RegExp[] = [
  // —— 把自己写小 ——
  /\bmock\b/i,
  /\bdemo\b/i,
  /\bfake\b/i,
  /演示/,
  /虚假/,
  /假数据/,
  /伪造/,
  /模拟/,
  /本地/,
  /示例/,
  /样例/,
  /虚拟/,
  // —— 工程内部术语外泄 ——
  /分片/,
  /首屏/,
  /字段/,
  /数据集/,
  /布局回归/,
  /压力测试/,
  // —— 旧品牌残留 ——
  /NebulaCloud/i,
  /nebulacloud/i,
];

/**
 * 逐条放行的技术标识符与合法文案。
 *
 * 每条都要写清「为什么可以放行」，否则后来的人只会往上加，白名单就烂了。
 *
 * ⚠️ BLF-1394 起，白名单的前提变了：BLF-1388 以为这些标识符「不显示给用户」，所以
 * 直接放行。事实是它们**确实**暴露给访客（DOM 的 target 属性、DevTools 的请求 URL、
 * 可下载的 JSON 里的生成器署名）—— 所以本轮把它们改掉了，白名单里不再有它们。
 * 留下来的每一条，都是**真的**不该被拦的。
 */
const ALLOWED: { file: string; contains: string; why: string }[] = [
  {
    file: "components/spark/pages/ContentPage.tsx",
    contains: "苏州本地赛事",
    why: "「本地」是地理含义（苏州本地举办的赛事），与 mock 无关，是正常业务文案",
  },
  {
    file: "lib/av/server.ts",
    contains: "告警分片为空",
    why: "服务端启动期的诊断异常文案，面向开发者排障，不在任何页面上展示",
  },
  {
    file: "lib/spark/security.ts",
    contains: "国密 SM4 字段级加密",
    why: "「字段级加密」是密码学标准术语（field-level encryption），不是 schema 术语",
  },
  {
    file: "middleware.ts",
    contains: 'const LEGACY_DATA_PREFIX = "/mock/av"',
    why: "旧数据目录的**兼容重定向**常量：它只用来把旧地址 308 到新目录，访客看到的地址已经变成新路径了",
  },
];

/**
 * 扫描范围。
 *
 * BLF-1388 只扫站点目录（`app/spark` / `app/stream-monitor` / `components/spark` /
 * `components/av` / `lib/spark` / `lib/av`）—— 结果工作台侧栏入口、手机端入口、
 * 更新日志、PWA manifest、middleware 都不在射程内，而它们全是用户可见的。
 * BLF-1394 把这些补上。
 */
const SITE_DIRS = [
  "app/spark",
  "app/stream-monitor",
  "components/spark",
  "components/av",
  "lib/spark",
  "lib/av",
];

/** 站点目录之外、但用户可见的单文件（BLF-1394 扩进来的）。 */
const SITE_EXTRA_FILES = [
  // 主工作台侧栏的站点入口（含分组标签与 target）
  "app/(dashboard)/layout.tsx",
  // 手机端「我的」抽屉里的站点入口
  "components/mobile/sheets/MineSheet.tsx",
  // 更新日志（向全部登录用户展示）
  "lib/changelog.ts",
  // PWA 清单（装到桌面后由系统展示）
  "app/manifest.ts",
  // 免登录放行与兼容重定向
  "middleware.ts",
];

/**
 * 公开静态数据集（访客可以直接在地址栏敲 `/stream-monitor-data/index.json` 下载）。
 *
 * BLF-1394 之前这个目录挂在 `/mock/av` 下，而且 index.json 里的 `generated_by`
 * 直接点名了 mock 生成器脚本 —— 它不是「技术标识符」，它是**可下载的内容**。
 * 所以这里把数据目录也纳入扫描范围。
 */
const PUBLIC_DATA_DIR = "public/stream-monitor-data";

const SITE_FILES = [
  ...SITE_DIRS.flatMap((dir) => filesUnder(dir, /\.tsx?$/)).filter(
    (file) => !/\.test\.ts$/.test(file),
  ),
  // 单文件：路径已经是相对 cwd 的，filesUnder 返回的是绝对路径，这里补齐。
  ...SITE_EXTRA_FILES.map((file) => resolve(process.cwd(), file)),
];

/** 公开静态数据集：全是 JSON，访客可下载。 */
const PUBLIC_DATA_FILES = filesUnder(PUBLIC_DATA_DIR, /\.json$/);

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

describe("生产介绍站点文案：不得出现 mock / 演示 / 工程术语措辞（BLF-1388 / BLF-1394）", () => {
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
    assert.ok(hits.length >= 1);
    // 注释被遮蔽后不参与匹配
    assert.equal(FORBIDDEN.some((pattern) => pattern.test(masked.split("\n")[1])), false);
  });

  it("公开静态数据集里也没有 mock / 演示类字样", () => {
    // 访客可以直接在地址栏敲 `/stream-monitor-data/index.json` 把整套数据下下来，
    // 里面的字段值也会被看到。BLF-1394 之前 index.json 的 generated_by 直接点名
    // 了 mock 生成器脚本。
    assert.ok(PUBLIC_DATA_FILES.length > 0, "公开数据目录扫不到文件，守卫会变成空跑");
    const offenders: Offender[] = [];
    for (const file of PUBLIC_DATA_FILES) offenders.push(...scan(file));
    assert.deepEqual(
      offenders.map((item) => `${item.file}:${item.line}: ${item.snippet}`),
      [],
    );
  });

  it("新增的工程术语也在词表里（不是只加了 mock 一类）", () => {
    // 逐个自证：词表扩了，但确实覆盖到了本轮要拦的那些词。
    for (const word of ["本地", "示例", "样例", "虚拟", "分片", "首屏", "字段", "数据集", "布局回归", "压力测试"]) {
      assert.ok(
        FORBIDDEN.some((pattern) => pattern.test(word)),
        `词表漏了「${word}」`,
      );
    }
  });

  it("不误伤合法文案：「苏州本地赛事」这种地理含义的「本地」必须放行", () => {
    // 反向验证：扩词表后若不区分「本地赛事（地理）」与「本地 Mock（自曝）」，
    // 就会把正常业务文案改坏。这里的「本地」是地理概念，与 mock 无关。
    const legal = 'const hint = "苏州本地赛事 · 2026 春季赛";';
    const masked = maskComments(legal);
    // 「本地」确实命中词表（所以需要白名单）
    assert.ok(FORBIDDEN.some((pattern) => pattern.test(masked)));
    // 但它被白名单放行，扫不出 offender
    const relative = "components/spark/pages/ContentPage.tsx";
    const allowed = ALLOWED.some(
      (entry) => entry.file === relative && legal.includes(entry.contains),
    );
    assert.ok(allowed, "「苏州本地赛事」必须在白名单里");
    // 而且这句文案在真实文件里仍然存在（不得被改掉）
    const content = readFileSync(
      resolve(process.cwd(), "components/spark/pages/ContentPage.tsx"),
      "utf8",
    );
    assert.match(content, /苏州本地赛事/);
  });

  it("公开数据目录里没有 mock 字样（访客能直接下载 index.json）", () => {
    // index.json 公开可下载，它里面的 generated_by 直接点名生成器脚本。
    const index = readFileSync(
      resolve(process.cwd(), "public/stream-monitor-data/index.json"),
      "utf8",
    );
    assert.doesNotMatch(index, /mock/i);
    assert.doesNotMatch(index, /demo/i);
  });

  it("站点标识符不再带 demo / mock（View Source 与 DOM 属性可见）", () => {
    // SPARK_WINDOW_TARGET 直接写进 DOM 的 target 属性，View Source 一眼可见。
    const navigation = readFileSync(resolve(process.cwd(), "lib/spark/navigation.ts"), "utf8");
    assert.match(navigation, /export const SPARK_WINDOW_TARGET = "spark-platform"/);
    assert.doesNotMatch(navigation, /spark-demo/);
    // 数据目录的新公开路径
    assert.match(
      readFileSync(resolve(process.cwd(), "lib/av/load.ts"), "utf8"),
      /export const DEFAULT_BASE_URL = "\/stream-monitor-data"/,
    );
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
