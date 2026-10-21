import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

/**
 * 副标题「只写数据」契约（BLF-1431 / Stage 7）。
 *
 * 面板头的 `subtitle` 原本是一条自由文案位，于是长出了 20 多条典型的 AI slop：
 * 复述标题（「网关与链路」下面写「网关与链路状态」）、解释图怎么读（「颜色越深代表
 * 该时段告警越多」）、营销口号（「实时检测 · 自动分级 · 闭环处置」）、空态操作指引
 * （「选择任意一起事件」）。这些话不是错，是**访客不需要** —— 标题、图例、空态正文
 * 已经把同一件事说过一遍了。
 *
 * ## 判定口径（本 Stage 的唯一标准）
 *
 * > `subtitle` 必须是**数据型**：含数字，或含 `${...}` 数据插值；
 * > 否则删。
 *
 * 也就是：副标题只回答「这屏数的是哪个窗口 / 多少条 / 筛出来几台」，
 * 不回答「这张图怎么读」「这个模块是干什么的」。
 *
 * ## 与另外两套守卫的分工
 *
 *   · `lib/av/siteBrandCopy.test.ts` —— 品牌（英文 `Stream Monitor` / 中文名 / URL）；
 *   · `lib/siteCopyGuard.test.ts` —— 措辞（mock / 演示 / 工程术语 / 内部口径）；
 *   · `lib/av/englishResidue.test.ts` —— 英文残留（大写串 / 分位记号 / locale code）；
 *   · 本文件 —— **副标题形状**：数据型才能留，删掉的句子进 denylist 防回填。
 *
 * 前三套都不管「这句话是不是在复述标题」，所以必须单独一套。
 */

/** 递归列出目录下所有 .tsx 源文件。 */
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
 * 遮蔽注释，**保留字符串内容**（与 `siteBrandCopy.test.ts` 同一个状态机）。
 *
 * 判 denylist 时必须先遮蔽注释：维护者完全可以在注释里引用那句被删掉的文案
 * （「这里原本写的是『选择任意一起事件』」），那是知识，不是回填。
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

/**
 * 扫描范围：所有会渲染 `AvPanel` / `AvPageHeader` 的页面。
 *
 * `__stress`（`StressView.tsx`）是内部校验页 —— 它刻意用「极端值样本的渲染校验」
 * 这类说明当副标题，验的是排版不是文案，按 Stage 7 的约定不在范围内。
 */
const PAGE_DIRS = ["components/av/pages", "app/stream-monitor"];
const SKIPPED_FILES = ["components/av/pages/StressView.tsx"];

const PAGE_FILES = PAGE_DIRS.flatMap((dir) => filesUnder(dir, /\.tsx$/)).filter((file) => {
  const relative = file.slice(resolve(process.cwd()).length + 1);
  if (/\.test\.tsx?$/.test(relative)) return false;
  return !SKIPPED_FILES.includes(relative);
});

/** 相对 cwd 的路径。 */
function relativeOf(file: string): string {
  return file.slice(resolve(process.cwd()).length + 1);
}

/**
 * 从 `subtitle` 的等号之后读一个 JSX 表达式。
 *
 * 引号形式（`subtitle="…"`）连引号一起返回 —— 调用方靠「有没有引号」判断
 * 这个值是写死的字面量还是纯变量引用（`subtitle={view.windowLabel}`）。
 */
function readExpression(source: string, from: number): string {
  let index = from;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (source[index] === '"' || source[index] === "'") {
    const quote = source[index];
    const end = source.indexOf(quote, index + 1);
    return source.slice(index, end < 0 ? source.length : end + 1);
  }
  if (source[index] !== "{") return "";
  let depth = 1;
  let cursor = index + 1;
  let out = "";
  while (cursor < source.length && depth > 0) {
    const char = source[cursor];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
    out += char;
    cursor += 1;
  }
  return out;
}

/**
 * 一个副标题：它在哪个文件、静态文本是什么、是不是数据型的。
 *
 * 数据型有三条通路：
 *   · `isLiteral === false` —— 整个值就是变量引用（`subtitle={view.windowLabel}`），
 *     文案来自数据集，页面里根本没有写死句子；
 *   · 含 `${...}` 插值（`近 180 天 · ${n} 次任务`）；
 *   · 静态文本里含数字（`每页 12 条`）。
 */
interface Subtitle {
  file: string;
  text: string;
  interpolated: boolean;
  /** 值里有没有字符串字面量；没有就是纯变量引用。 */
  isLiteral: boolean;
}

/** 取源码里所有 `subtitle=` 的取值。 */
function subtitlesOf(file: string, source: string): Subtitle[] {
  const out: Subtitle[] = [];
  const needle = "subtitle=";
  let index = source.indexOf(needle);
  while (index >= 0) {
    const expression = readExpression(source, index + needle.length);
    if (expression) {
      const interpolated = expression.includes("${");
      // 静态文本 = 抹掉插值后的字符串内容（并去掉包裹的引号）
      const text = expression.replace(/\$\{[^}]*\}/g, "").replace(/["'`]/g, "");
      const isLiteral = /["'`]/.test(expression);
      out.push({ file: relativeOf(file), text, interpolated, isLiteral });
    }
    index = source.indexOf(needle, index + needle.length);
  }
  return out;
}

/**
 * 允许不带数字的副标题（白名单）。
 *
 * 只有两类能进：**范围标签**（不含数字但也不是句子）与**诚实的能力说明**
 * （站点没有的能力必须说出来，删掉才是撒谎）。每条都要写理由。
 */
const ALLOWED_SUBTITLES: { file: string; text: string; why: string }[] = [
  {
    file: "components/av/pages/DeviceView.tsx",
    text: "离线 / 维护中",
    why: "范围标签（这张面板只列离线与维护中的设备），不是句子；计数已经在面板头右侧的 meta 里",
  },
  {
    file: "components/av/pages/CapabilityView.tsx",
    text: "规则为只读展示，当前不可编辑",
    why: "诚实的能力说明：规则不可编辑是事实，删掉会让访客以为能点开关（BLF-1397 起刻意保留）",
  },
];

/**
 * 反回填 denylist：§B 删掉的句子。
 *
 * 命中即失败 —— 这些句子一字不差地被删过，回来任何一个都说明有人又「顺手补了一句」。
 * 只收**整句 / 特征短语**：太短的词（如「今日调用量」）会误伤合法文案，交给上面的
 * 「必须含数字 / 插值」形状规则去守。
 */
const REMOVED_SUBTITLES = [
  "多模态融合感知 · 全场景智能安防",
  "（告警 / 已处置 / 事件 / 误报）",
  "全量 vs 未处置拆分",
  "告警按业务场景",
  "颜色越深代表该时段告警越多",
  "按告警总量排序",
  "按告警条数排序",
  "最新告警按时间滚动",
  "多模态感知通道",
  "网关 / 拾音 / 视觉终端",
  "网关与链路状态",
  "实时检测 · 自动分级 · 闭环处置",
  "待确认与处置中告警的分级构成",
  "每个剧本都有完整时间线",
  "两类都可全程追溯",
  "事件关联的告警与音视频证据",
  "选择任意一起事件",
  "设备台账、在线率与离线清单",
  "全量设备当前状态",
  "按站点统计在线 / 离线",
  "按最近心跳倒序",
  "按台数排序",
  "折线为在线率",
  "从拾音采集到多模态融合，再到分级处置的完整链路",
  "频谱与说话人转写",
  "颜色深浅代表能量强度",
  "与告警级别的对应关系",
];

/**
 * 已遮蔽注释的源码。
 *
 * 用数组而不是 `Map`：根 tsconfig 没有显式 `target`，迭代 Map 会被
 * 「downlevelIteration」挡下来（测试走 tsconfig.test.json，编辑器的类型检查
 * 走根配置，两边都得过）。
 */
/**
 * 同类实现细节外泄（不在 §B 表里，但性质相同，是全局判断时抓到的）。
 *
 * 音频页曾把数据集的 `spectrum.note` 原样渲染 —— 那是一段「行 = 频点（0 + bins × binHz Hz）…
 * 解码：base64 → Uint8Array」的编码说明，访客一个字都用不上。数据字段保留（不改字段语义），
 * **渲染**删掉。播放说明里的 rAF / CSS transition 同理：诚实披露（没有音频文件）留下，
 * 实现方式不上屏。
 */
const REMOVED_JARGON = ["bins × binHz", "解码：base64", "索引 = col + bins", "rAF 驱动", "不用 CSS transition"];

const SOURCES: { file: string; source: string }[] = PAGE_FILES.map((file) => ({
  file,
  source: maskComments(readFileSync(file, "utf8")),
}));

/** 所有副标题（拍平）。 */
function allSubtitles(): Subtitle[] {
  const out: Subtitle[] = [];
  for (const entry of SOURCES) out.push(...subtitlesOf(entry.file, entry.source));
  return out;
}

describe("副标题只写数据（BLF-1431）", () => {
  it("每个 subtitle 都含数字或数据插值，否则必须显式加白", () => {
    const offenders: string[] = [];
    for (const subtitle of allSubtitles()) {
      const hasDigit = /\d/.test(subtitle.text);
      if (!subtitle.isLiteral || subtitle.interpolated || hasDigit) continue;
      const allowed = ALLOWED_SUBTITLES.some(
        (entry) => entry.file === subtitle.file && subtitle.text.includes(entry.text),
      );
      if (allowed) continue;
      offenders.push(`${subtitle.file}: ${subtitle.text.trim().slice(0, 80)}`);
    }
    assert.deepEqual(offenders, []);
  });

  it("§B 删掉的句子没有回填（denylist）", () => {
    const offenders: string[] = [];
    for (const entry of SOURCES) {
      for (const sentence of REMOVED_SUBTITLES) {
        if (!entry.source.includes(sentence)) continue;
        offenders.push(`${relativeOf(entry.file)}: ${sentence}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("实现细节（编码 / 绘制方式）不上屏", () => {
    const offenders: string[] = [];
    for (const entry of SOURCES) {
      for (const phrase of REMOVED_JARGON) {
        if (!entry.source.includes(phrase)) continue;
        offenders.push(`${relativeOf(entry.file)}: ${phrase}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("白名单每条都写了理由，且指向真实存在、仍然没有数字的副标题", () => {
    const all = allSubtitles();
    for (const entry of ALLOWED_SUBTITLES) {
      assert.ok(entry.why.length > 8, `白名单「${entry.text}」缺少像样的理由`);
      const match = all.find(
        (subtitle) => subtitle.file === entry.file && subtitle.text.includes(entry.text),
      );
      assert.ok(match, `白名单条目已失效（找不到副标题）：${entry.file} · ${entry.text}`);
      // 白名单只该装「没有数字也不带插值」的副标题；一旦补上数字就该删掉白名单
      assert.equal(/\d/.test(match.text), false, `「${entry.text}」已经有数字了，请删掉白名单条目`);
    }
  });

  it("守卫不是空跑：确实扫到了这么多副标题，且样本会被判违规", () => {
    const all = allSubtitles();
    // 五页 + capability / audio + 音频空态页，删完 slop 后仍应有 15 条以上数据型副标题；
    // 太少说明扫描范围断了（文件被搬走 / 目录名改了）
    assert.ok(all.length >= 15, `只扫到 ${all.length} 条 subtitle，范围不对`);
    assert.ok(
      all.some((subtitle) => subtitle.file.endsWith("AlarmView.tsx")),
      "漏扫了告警页",
    );

    const sample = 'subtitle="每个剧本都有完整时间线，可回看处置过程"';
    const sampleFile = resolve(process.cwd(), "__sample__.tsx");
    assert.deepEqual(subtitlesOf(sampleFile, sample), [
      {
        file: "__sample__.tsx",
        text: "每个剧本都有完整时间线，可回看处置过程",
        interpolated: false,
        isLiteral: true,
      },
    ]);
    // 纯变量引用（没有字符串字面量）算数据型：文案来自数据，页面里没写句子
    const refSample = "subtitle={view.windowLabel}";
    assert.equal(subtitlesOf(sampleFile, refSample)[0].isLiteral, false);
    const dataSample = "subtitle={`近 180 天 · ${count} 次任务`}";
    const parsed = subtitlesOf(sampleFile, dataSample)[0];
    assert.equal(parsed.interpolated, true);
    assert.equal(/\d/.test(parsed.text), true);
  });

  it("StressView（内部校验页）不在范围内，但没有被误删", () => {
    const relatives = PAGE_FILES.map(relativeOf);
    assert.ok(!relatives.includes("components/av/pages/StressView.tsx"));
    const stress = readFileSync(resolve(process.cwd(), "components/av/pages/StressView.tsx"), "utf8");
    assert.ok(stress.includes("subtitle="), "内部校验页的副标题被删了，那不在本 Stage 范围内");
  });
});
