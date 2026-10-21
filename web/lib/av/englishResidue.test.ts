import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

/**
 * 界面英文残留契约（BLF-1431 / Stage 7）。
 *
 * 站点面向国内市场：**用户可见的字里不许留英文**，只有「专有型号 / 单位 / 标准号 /
 * 编号」可以留。这类残留没法靠人眼守 —— 「P90」「LIVE」「zh-CN」都是两三个字母，
 * 评审看一眼就滑过去了，所以钉成用例：新增英文必须**显式加白并写明理由**才能绿。
 *
 * ## 与另外两套文案守卫的分工（别重复、也别绕过）
 *
 *   · `lib/av/siteBrandCopy.test.ts` —— 守**品牌**：不许出现英文 `Stream Monitor`，
 *     中文品牌「智能音视频平台」必须真的在，URL 前缀 `/stream-monitor` 不许动。
 *   · `lib/siteCopyGuard.test.ts` —— 守**措辞**：mock / 演示 / 工程术语 / 内部口径。
 *   · 本文件（BLF-1431 新增）—— 守**字母表**：用户可见字符串里不许出现
 *     「两个以上连续大写拉丁字母」的词、`P90` 这类分位记号，或 `xx-XX` 形式的
 *     locale code。
 *
 * 三者扫的范围有重叠（都扫 `components/av` / `lib/av`），但守的东西互不包含：
 * 「RSSI」不违反品牌与措辞，却违反这里；「点击行查看时间线」不违反这里，
 * 却违反 siteCopyGuard。
 *
 * ## 扫什么
 *
 *   1. `components/av` + `lib/av` 的 `.ts` / `.tsx`（测试文件除外）里的**字符串字面量**；
 *   2. `public/stream-monitor-data/*.json` 的字符串值（访客可以直接下载这些文件）。
 *
 * 注释不扫 —— 注释是给维护者的知识（`maskComments` 也顺手保证了「字符串里的 `//`
 * 不会被当成注释开头」）。`__stress` 是内部校验页，按 Stage 7 的约定不在范围内。
 *
 * ## 判定口径
 *
 * 命中即失败，除非命中串在白名单里（每条必须写 `why`）。白名单只收三类：
 *   ① 专有型号 / 编号前缀（`AV-` / `AL-` / `PT-` …）；
 *   ② 计量单位（`GB` / `dBm` / `ms` …）与编码标准（`H.265`）；
 *   ③ 不渲染的机器可读值（locale code、场景代码、base64 字母表、内联脚本）。
 */

/** 递归列出目录下所有源文件。 */
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
 * 遮蔽注释，**保留字符串内容**（与 `siteBrandCopy.test.ts` 的同一个状态机）。
 *
 * 用词法状态机而不是「行首 `//`」正则：后者会把字符串里的两个斜杠当成注释开头，
 * 从那儿截断整行，后面真正含英文的字符串就漏扫了。
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

/** 扫描范围：站点目录里的源码（测试与内部校验页除外）。 */
const SOURCE_DIRS = ["components/av", "lib/av"];
/** 内部校验页：`__stress` 是「最坏情况长什么样」的内部页面，不在面向市场的文案范围内。 */
const SKIPPED_FILES = ["components/av/pages/StressView.tsx"];

/** 公开静态数据集：访客能直接下载，里面的字段值也会被看到。 */
const PUBLIC_DATA_DIR = "public/stream-monitor-data";

const SOURCE_FILES = SOURCE_DIRS.flatMap((dir) => filesUnder(dir, /\.tsx?$/)).filter((file) => {
  const relative = file.slice(resolve(process.cwd()).length + 1);
  if (/\.test\.tsx?$/.test(relative)) return false;
  return !SKIPPED_FILES.includes(relative);
});

const DATA_FILES = filesUnder(PUBLIC_DATA_DIR, /\.json$/);

/** 两个以上连续大写拉丁字母（`LIVE` / `RSSI` / `ROI` / `FPS` …）。 */
const UPPER_RUN = /[A-Z]{2,}/;
/**
 * 分位记号（`P90` / `P50` / `P10`）。
 *
 * 单个大写字母 + 两位数字 —— 上面那条规则抓不到（只有 1 个连续大写字母），
 * 但它恰好是本轮最典型的一类残留：界面上改成「中位 / 较高分位 / 较低分位」，
 * 数值仍显示。不单独钉住的话，`P90` 回填不会有任何守卫变红。
 */
const PERCENTILE_MARK = /(?<![A-Za-z0-9])P\d{1,2}(?!\d)/;
/** locale code：`zh-CN` / `en-US` —— 把语言代码渲染到界面上是最典型的英文残留。 */
const LOCALE_CODE = /(?<![a-z])[a-z]{2}-[A-Z]{2}(?![a-z])/;

/** 判定顺序：先认 locale code，再认分位记号与连续大写。 */
const PATTERNS: RegExp[] = [LOCALE_CODE, PERCENTILE_MARK, UPPER_RUN];

/**
 * 白名单：命中串 → 为什么可以留。
 *
 * 每条都要写清理由，否则后来的人只会往上加，白名单就烂了。
 * `files` 可选：给了就只在这些文件里放行（用于「机器可读值」这类不该在别处出现的东西）。
 */
interface AllowEntry {
  match: string;
  why: string;
  files?: string[];
}

const ALLOWED: AllowEntry[] = [
  // —— ① 专有型号 / 编号前缀（编号是主键，中文化会让对账与深链接失效）——
  { match: "AV", why: "设备型号前缀 AV-MIC-S6 / AV-CAM-PTZ / AV-GW-200，型号是专有名词，保留原样" },
  { match: "MIC", why: "型号 AV-MIC-S6/S8 的组成部分，与出厂型号一一对应" },
  { match: "CAM", why: "型号 AV-CAM-360 / AV-CAM-PTZ 的组成部分" },
  { match: "GW", why: "型号 AV-GW-200 的组成部分" },
  { match: "PT", why: "点位编号前缀 PT-B1-1F01（点位是数据主键，界面按编号检索）" },
  { match: "AL", why: "告警编号前缀 AL-00037：编号是搜索 / 深链接 / 抽屉对账的主键" },
  { match: "EV", why: "事件编号前缀 EV-20260145" },
  { match: "IP", why: "审讯辅助记录编号前缀 IP-00008" },
  { match: "DO", why: "处置记录编号前缀 DO-0045" },
  { match: "OT", why: "固件升级记录编号前缀 OT-0038" },
  { match: "CF", why: "配置变更记录编号前缀 CF-0002" },
  { match: "MR", why: "人工补录记录编号前缀 MR-0001" },
  { match: "FP", why: "误报归档记录编号前缀 FP-0031" },
  { match: "WO", why: "工单编号前缀 WO-20261019-011" },
  { match: "OTA", why: "固件升级记录编号前缀 OTA-1001-1（界面上「OTA 升级」已改「固件升级」，编号不动）" },
  { match: "SS", why: "站点编码（PT-SS-… 里的站点段），是点位编号的组成部分" },
  { match: "ST", why: "站点编码（PT-ST-… 里的站点段）" },
  { match: "GY", why: "站点编码（PT-GY-… 里的站点段）" },
  { match: "HM", why: "站点编码（PT-HM-… 里的站点段）" },
  { match: "GA", why: "站点编码（PT-GA-… 里的站点段）" },
  { match: "SY", why: "站点编码字段 `sites[].code`，机器可读，不渲染" },
  { match: "TT", why: "站点编码（PT-TT-… 里的站点段）" },
  { match: "ICU", why: "重症监护室的行业通用缩写（医院场景的标准叫法），比「重症监护室」更短且不歧义" },
  { match: "AI", why: "「视觉 AI / AI 算法」是国内行业的通用名词，不属于可替换的说明性英文" },

  // —— ② 计量单位 / 编码标准 ——
  { match: "GB", why: "存储容量单位（GB / TB / PB），单位符号不翻译" },
  { match: "TB", why: "存储容量单位（formatStorage 的 TB 档）" },
  { match: "PB", why: "存储容量单位（formatStorage 里 >1000TB 的那一档）" },
  { match: "BA", why: "「dBA」里的分贝单位（A 计权），是声学标准符号" },
  { match: "HBM", why: "HBM3 是显存标准型号（与 H.265 同类的专有名词）" },
  { match: "UTC", why: "UTC+8 是时区标识（数据集 `timezone` 字段值），不是可翻译的界面措辞" },

  // —— ③ 不渲染的机器可读值 / 运行时字符串 ——
  {
    match: "zh-CN",
    why: "语言代码：展示层经 `transcriptLanguageLabel` 映射成「普通话」，代码本身是机器可读值",
    files: ["lib/av/labels.ts", "public/stream-monitor-data/transcripts.json"],
  },
  {
    match: "zh-TW",
    why: "语言代码：映射表的键，展示层输出「台湾地区国语」",
    files: ["lib/av/labels.ts"],
  },
  {
    match: "zh-HK",
    why: "语言代码：映射表的键，展示层输出「粤语」",
    files: ["lib/av/labels.ts"],
  },
  {
    match: "CAMPUS",
    why: "场景代码（数据集 `scenes[].code` 原值），能力页经 `sceneCodeLabel` 映射成「校园」",
    files: ["public/stream-monitor-data/scenes.json"],
  },
  {
    match: "HOSPITAL",
    why: "场景代码原值，展示层映射成「医院」",
    files: ["public/stream-monitor-data/scenes.json"],
  },
  {
    match: "JUSTICE",
    why: "场景代码原值，展示层映射成「公安」",
    files: ["public/stream-monitor-data/scenes.json"],
  },
  {
    match: "BLF",
    why: "`calc_note` 里的 issue 键（开发口径备注字段，不在任何页面上渲染）",
    files: ["public/stream-monitor-data/overview-ranges.json"],
  },
  {
    match: "APP",
    why: "「班主任 APP 提醒」出现在数据集的事件时间线正文里；APP 已是国内通用名词，脱数据映射会破坏原值",
    files: ["public/stream-monitor-data/scenes.json", "public/stream-monitor-data/incidents.json"],
  },
  {
    match: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    why: "base64 字母表常量（频谱 / 波形的解码表），不是文案",
    files: ["components/av/pages/AudioView.tsx"],
  },
  {
    match: "PTS",
    why: "`dateTime=\"PT{秒}S\"` 抹掉插值后剩下的 ISO-8601 时长片段，机器属性，不渲染",
    files: ["components/av/motion/AvLiveBadge.tsx"],
  },
  {
    match: "HTTP",
    why: "加载失败时附带的协议名，保留才能排障（`加载失败 /xxx（HTTP 404）`）",
    files: ["lib/av/load.ts"],
  },
  {
    match: "JSON",
    why: "数据集解析失败的诊断文案，面向开发者排障",
    files: ["lib/av/load.ts", "lib/av/server.ts"],
  },
  {
    match: "URLS",
    why: "首帧内联脚本里 `new URLSearchParams(...)` 的大写片段，纯运行时字符串，不进任何文案",
    files: ["lib/av/motion.ts"],
  },
];

/** 命中位置：文件 + 行号 + 命中串。 */
interface Offender {
  file: string;
  line: number;
  snippet: string;
  match: string;
}

/** 相对 cwd 的路径（白名单按相对路径匹配）。 */
function relativeOf(file: string): string {
  return file.slice(resolve(process.cwd()).length + 1);
}

function allowedIn(match: string, relative: string): boolean {
  return ALLOWED.some(
    (entry) => entry.match === match && (!entry.files || entry.files.includes(relative)),
  );
}

/**
 * 从一行已遮蔽注释的源码里取「用户可见的字符串片段」。
 *
 * 只取静态部分：模板字面量里的 `${...}` 是代码，不是文案（`${DEVICE_STREAM_TICK_SECONDS}`
 * 这种常量名大写一抓一大把，扫进去只会制造噪音）。
 * 模块路径（`./AvUI.module.css`、`@/components/av/AvUI`）不是文案，直接跳过。
 */
function literalSegments(line: string): string[] {
  const withoutInterpolation = line.replace(/\$\{[^}]*\}/g, "");
  const out: string[] = [];
  // 用 exec 循环而不是 `matchAll`：`matchAll` 返回迭代器，根 tsconfig 没有显式 target 时
  // 会被「downlevelIteration」挡下来（这里的测试由 tsconfig.test.json 编译，
  // 但编辑器的类型检查走根配置，两边都得过）。
  const pattern = /'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`/g;
  let match = pattern.exec(withoutInterpolation);
  while (match) {
    const text = match[1] ?? match[2] ?? match[3];
    if (text && !/^(@\/|\.{1,2}\/)/.test(text)) out.push(text);
    match = pattern.exec(withoutInterpolation);
  }
  return out;
}

/**
 * 取一个字符串里的全部英文命中。
 *
 * locale code 命中时不再报它内部的大写段（`zh-CN` 里的 `CN`）：
 * 同一个东西报两次只会让白名单越写越长。
 */
function matchesOf(text: string): string[] {
  const found: string[] = [];
  for (const pattern of PATTERNS) {
    const hit = pattern.exec(text);
    if (!hit) continue;
    const value = hit[0];
    if (found.some((item) => item.includes(value))) continue;
    found.push(value);
  }
  return found;
}

function scanSource(file: string): Offender[] {
  const relative = relativeOf(file);
  const masked = maskComments(readFileSync(file, "utf8"));
  const offenders: Offender[] = [];
  masked.split("\n").forEach((line, offset) => {
    for (const text of literalSegments(line)) {
      for (const value of matchesOf(text)) {
        if (allowedIn(value, relative)) continue;
        offenders.push({
          file: relative,
          line: offset + 1,
          snippet: text.trim().slice(0, 100),
          match: value,
        });
      }
    }
  });
  return offenders;
}

/** 遍历 JSON 里的字符串值（键是 schema，不渲染，不扫）。 */
function jsonStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    // 频谱矩阵是 base64 二进制载荷（638KB），不是文案
    if (/^[A-Za-z0-9+/=]{40,}$/.test(value)) return;
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) jsonStrings(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) jsonStrings(item, out);
  }
}

function scanData(file: string): Offender[] {
  const relative = relativeOf(file);
  const values: string[] = [];
  jsonStrings(JSON.parse(readFileSync(file, "utf8")), values);
  const offenders: Offender[] = [];
  for (const text of values) {
    for (const value of matchesOf(text)) {
      if (allowedIn(value, relative)) continue;
      offenders.push({ file: relative, line: 0, snippet: text.trim().slice(0, 100), match: value });
    }
  }
  return offenders;
}

describe("界面英文残留（BLF-1431）", () => {
  it("站点源码里的用户可见字符串没有英文残留", () => {
    const offenders = SOURCE_FILES.flatMap(scanSource);
    assert.deepEqual(
      offenders.map((item) => `${item.file}:${item.line}: [${item.match}] ${item.snippet}`),
      [],
    );
  });

  it("公开数据集里的字符串值没有英文残留（访客可以直接下载）", () => {
    assert.ok(DATA_FILES.length > 0, "公开数据目录扫不到文件，守卫会变成空跑");
    const offenders = DATA_FILES.flatMap(scanData);
    assert.deepEqual(
      offenders.map((item) => `${item.file}: [${item.match}] ${item.snippet}`),
      [],
    );
  });

  it("扫描范围非空，且确实跳过了内部校验页与测试文件", () => {
    const relatives = SOURCE_FILES.map(relativeOf);
    assert.ok(relatives.length > 20, `只扫到 ${relatives.length} 个源文件，范围不对`);
    assert.ok(relatives.includes("components/av/pages/MonitorView.tsx"), "漏扫了五页之一");
    assert.ok(!relatives.includes("components/av/pages/StressView.tsx"), "内部校验页不在范围内");
    assert.ok(
      relatives.every((file) => !/\.test\.tsx?$/.test(file)),
      "测试文件不该参与用户可见文案扫描",
    );
  });

  it("守卫不是空跑：样本串会被抓到，白名单外的新英文一定会红", () => {
    // 三类命中各来一发：连续大写、分位记号、locale code
    assert.deepEqual(matchesOf("LIVE"), ["LIVE"]);
    assert.deepEqual(matchesOf("P90"), ["P90"]);
    assert.deepEqual(matchesOf("zh-CN"), ["zh-CN"]);
    assert.deepEqual(matchesOf("25FPS"), ["FPS"]);
    // 单字母、编码标准、大写开头的普通单词不该被误伤
    assert.deepEqual(matchesOf("H.265"), []);
    assert.deepEqual(matchesOf("Hello"), []);
    assert.deepEqual(matchesOf("规格 4K · 显存 24GB"), ["GB"]);
    // 命中后没有白名单 → 一定是 offender
    assert.equal(allowedIn("LIVE", "components/av/pages/MonitorView.tsx"), false);
    assert.equal(allowedIn("RSSI", "components/av/pages/MonitorView.tsx"), false);
    assert.equal(allowedIn("zh-CN", "components/av/pages/AudioView.tsx"), false);
  });

  it("白名单每条都写了理由，且文件范围真实存在", () => {
    for (const entry of ALLOWED) {
      assert.ok(entry.why.length >= 6, `白名单「${entry.match}」缺少像样的理由`);
      for (const file of entry.files ?? []) {
        assert.ok(existsSync(resolve(process.cwd(), file)), `白名单指向了不存在的文件：${file}`);
      }
    }
  });

  it("模板插值里的常量名不算文案（否则 ${DEVICE_STREAM_TICK_SECONDS} 会被误报）", () => {
    const line = '  subtitle={`每 ${DEVICE_STREAM_TICK_SECONDS} 秒刷新`},';
    // 只留下静态文本，插值部分（常量名）被抹掉
    assert.deepEqual(literalSegments(line), ["每  秒刷新"]);
    assert.equal(UPPER_RUN.test(literalSegments(line).join("")), false);
  });
});
