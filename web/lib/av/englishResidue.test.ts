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
 *   1. `components/av` + `lib/av` + `app/stream-monitor` 的 `.ts` / `.tsx`
 *      （测试文件除外）里的**用户可见文本**：
 *      · 字符串字面量（`'…'` / `"…"` / `` `…` `` 的静态部分，含 JSX 属性值）；
 *      · `.tsx` 里的 **raw JSX 文本节点**（`>` 与 `<` 之间、不是 `{…}` 表达式的那一段），
 *        含**标签属性里**的 JSX children（`aside={<span>…</span>}`）。
 *   2. `public/stream-monitor-data/*.json` 的字符串值（访客可以直接下载这些文件）。
 *
 * **两层都是「整份源码一次词法遍历」，不能逐行**：一个跨行模板字面量的首行只有开引号、
 * 中间行没有引号、末行只有闭引号，逐行扫的话三行都匹配不到 —— 而本 Stage 自己改的那条
 * 副标题就是三行（`DeviceView.tsx` 的 `subtitle={`每 2 小时…（${…}）`}`，同类的还有
 * `EventView.tsx` 两处）。行号靠「命中在段内的下标 + 整份源码的 `lineStarts`」算，
 * 所以三行副标题里的 `LIVE` 报的是它真正所在的那一行，不是开引号那一行。
 *
 * 路由层（`app/stream-monitor`）必须扫：本 Stage 自己就改过 `app/stream-monitor/audio/page.tsx`
 * 的空态 `hint`，而路由文件里的 `metadata.title` / 空态提示 / 页头文案都是直接上屏的。
 * 这与 `siteCopyGuard.test.ts` 的 `SITE_DIRS` 同一口径（那边也是 `app/stream-monitor` 起手）。
 *
 * raw JSX 文本节点必须扫：这套 UI 的可见文案大量是 children 而不是属性值 ——
 * `<th className={s.num}>处理器占用</th>`、`<span>中位</span>` 都在这一类里，
 * 只抓引号字面量的话，本 Stage 改的表头 / 徽标 / 抽屉小标题回填成英文不会有任何信号。
 *
 * 注释不扫 —— 注释是给维护者的知识（`maskComments` 也顺手保证了「字符串里的 `//`
 * 不会被当成注释开头」）。`__stress` 是内部校验页，按 Stage 7 的约定不在范围内
 * （组件 `StressView.tsx` 与路由页 `app/stream-monitor/%5F%5Fstress/page.tsx` 一并排除）。
 *
 * ## 判定口径
 *
 * 命中即失败，除非命中串在白名单里（每条必须写 `why`）。白名单只收三类：
 *   ① 专有型号 / 编号前缀（`AV-` / `AL-` / `PT-` …）；
 *   ② 计量单位（`GB` / `dBm` / `ms` …）与编码标准（`H.265`）；
 *   ③ 不渲染的机器可读值（locale code、场景代码、base64 字母表、内联脚本）。
 *
 * **一个字符串里的每一处英文命中都要过白名单**（而不是只看第一处）：
 * 否则 `AV-MIC-S6 · LIVE` 里 `AV` 加过白，`MIC` / `LIVE` 就跟在型号后面蒙混过关了。
 *
 * **整张白名单表必须二分**：要么带形状（`context` 规定编号 / 型号长什么样，`files` 限定
 * 机器值只在哪几个文件里出现），要么进 `SHAPE_EXEMPT` 例外集合（单位符号 / 行业通用词 /
 * 标准号 —— 它们本来就没有形状可言）。裸的 `match: "MIC"` 会把「MIC 通道信号质量」
 * 这种散文放过去，白名单等于形同虚设 —— 这条契约由「白名单契约」那条用例守着，
 * 表里新加一条不满足就会红，不靠人记。
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
const SOURCE_DIRS = ["components/av", "lib/av", "app/stream-monitor"];
/**
 * 内部校验页：`__stress` 是「最坏情况长什么样」的内部页面，不在面向市场的文案范围内。
 *
 * 目录名在磁盘上是 URL-encode 过的 `%5F%5Fstress`（Next 把下划线开头的目录当私有目录，
 * 见该页文件头），所以路由页那一份要按磁盘路径排除，不能按 `/__stress` 写。
 */
const SKIPPED_FILES = [
  "components/av/pages/StressView.tsx",
  "app/stream-monitor/%5F%5Fstress/page.tsx",
];

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
 *
 * **每一条必须二分**：要么带形状（`context` / `files` —— 命中的是编号、型号或机器值），
 * 要么在下面的 `SHAPE_EXEMPT` 例外集合里（单位符号 / 行业通用词 / 标准号）。
 * 裸的 `match: "MIC"` 会把「MIC 通道信号质量」这种散文放过去，等于白名单形同虚设 ——
 * 这条契约由「白名单契约」那条用例守着，表里新加一条不满足就会红。
 */
interface AllowEntry {
  match: string;
  why: string;
  files?: string[];
  /**
   * 命中串所在的整段字符串还必须匹配这条正则才放行。
   *
   * 用于「只有长成编号形状时才是编号」的前缀 / 型号：`OTA-1001-1` 放行，
   * `OTA 批量升级：…` 这种散文标题必须继续变红。
   */
  context?: RegExp;
}

/**
 * 例外集合：这些命中**没有形状可言**（单位符号 / 行业通用词 / 标准号），
 * 所以允许裸 `match`。不在这里、又没有 `context` / `files` 的条目会被用例拦下。
 *
 * `GB` / `TB` / `PB` 是存储单位（`formatStorage` 的档位字符串就是 `"GB"` 本身，写不出形状）；
 * `ICU` / `AI` 是国内行业里比中文更短的通用叫法。
 */
const SHAPE_EXEMPT = new Set(["GB", "TB", "PB", "ICU", "AI"]);

/**
 * 楼栋 / 站点编码：既是点位编号 `PT-SS-1F01` 里的站点段，又是数据集里单独成值的字段
 * （`sites[].code` / `points[].building`）。两种用法两种形状，所以每个编码两条。
 */
const SITE_CODES: Array<[code: string, label: string]> = [
  ["SS", "宿舍楼"],
  ["ST", "食堂"],
  ["GY", "操场"],
  ["HM", "门诊住院综合楼"],
  ["GA", "执法办案楼"],
  ["SY", "示范第一中学"],
  ["TT", "天台"],
];

/** 站点 / 楼栋编码以原值出现的数据文件（展示层经 `buildingName` 映射成中文）。 */
const SITE_CODE_FILES = [
  "public/stream-monitor-data/sites.json",
  "public/stream-monitor-data/points.json",
];

const ALLOWED: AllowEntry[] = [
  // —— ① 专有型号 / 编号（编号是主键，中文化会让对账与深链接失效）——
  //
  // 这一组全部带 `context`：只有长成型号 / 编号才会放行。少一个 `context`，散文里的同名
  // 英文（「MIC 通道信号质量」「PT 点位」「DO 一次整机复位」）就跟着蒙混过去了。
  {
    match: "AV",
    why: "设备型号前缀 AV-MIC-S6 / AV-CAM-PTZ / AV-GW-200，型号是专有名词，保留原样",
    context: /AV-(MIC|CAM|GW)/,
  },
  {
    match: "MIC",
    why: "型号 AV-MIC-S6 / AV-MIC-S8 的组成部分，与出厂型号一一对应",
    context: /AV-MIC/,
  },
  {
    match: "CAM",
    why: "型号 AV-CAM-360 / AV-CAM-PTZ 的组成部分",
    context: /AV-CAM/,
  },
  { match: "GW", why: "型号 AV-GW-200 的组成部分", context: /AV-GW/ },
  {
    match: "PT",
    why: "点位编号前缀 PT-B1-1F01 / PT-HM-1F01（点位是数据主键，界面按编号检索）",
    context: /PT-[A-Z0-9]+-\d+F\d+/,
  },
  { match: "AL", why: "告警编号前缀 AL-00037：编号是搜索 / 深链接 / 抽屉对账的主键", context: /AL-\d{5,}/ },
  { match: "EV", why: "事件编号前缀 EV-20260145 / EV-R0045", context: /EV-(R\d{4}|\d{8})/ },
  { match: "IP", why: "巡检计划编号前缀 IP-00008", context: /IP-\d{4,}/ },
  { match: "DO", why: "处置记录编号前缀 DO-0045", context: /DO-\d{4,}/ },
  { match: "OT", why: "固件升级记录编号前缀 OT-0038", context: /OT-\d{4,}/ },
  { match: "CF", why: "配置变更记录编号前缀 CF-0002", context: /CF-\d{4,}/ },
  { match: "MR", why: "人工补录记录编号前缀 MR-0001", context: /MR-\d{4,}/ },
  { match: "FP", why: "误报归档记录编号前缀 FP-0031", context: /FP-\d{4,}/ },
  { match: "WO", why: "工单编号前缀 WO-20261019-011", context: /WO-\d{8}-\d{3}/ },
  {
    match: "OTA",
    why: "固件升级记录编号 OTA-1001-1（`ota_records[].id`）：编号是抽屉对账的主键，界面措辞已改「固件升级」",
    // 只放行编号形状：`OTA 批量升级：…` 这类散文标题（曾漏进 /event 的 20 条）必须变红。
    context: /OTA-\d+-\d+/,
  },
  {
    match: "PTZ",
    why: "型号 AV-CAM-PTZ 的组成部分（云台变焦机型），与出厂型号一一对应，拆开就不再是型号",
    // 与 `OTA` 同一口径：型号组成部分也要带形状，散文里的 `PTZ` 不许借型号名蒙混过关。
    context: /AV-CAM-PTZ/,
  },
  // 楼栋 / 站点编码的两种形状（见 `SITE_CODES`）
  ...SITE_CODES.flatMap(([code, label]): AllowEntry[] => [
    {
      match: code,
      why: `点位编号 PT-${code}-1F01 里的站点段（界面显示「${label}」）`,
      context: new RegExp(`PT-${code}-`),
    },
    {
      match: code,
      why: `站点 / 楼栋编码原值（sites[].code / points[].building），机器可读字段，展示层映射成「${label}」`,
      files: SITE_CODE_FILES,
    },
  ]),

  // —— ② 例外：单位符号 / 行业通用词（没有形状可言，见 `SHAPE_EXEMPT`）——
  { match: "GB", why: "存储容量单位（GB / TB / PB）：`formatStorage` 的档位字符串就是 `GB` 本身，单位符号不翻译" },
  { match: "TB", why: "存储容量单位（formatStorage 里 1000GB 以上那一档）" },
  { match: "PB", why: "存储容量单位（formatStorage 里 >1000TB 的那一档）" },
  { match: "ICU", why: "重症监护室的行业通用缩写（医院场景的标准叫法），比「重症监护室」更短且不歧义" },
  { match: "AI", why: "「视觉 AI / AI 算法」是国内行业的通用名词，不属于可替换的说明性英文" },

  // —— ③ 带形状的标准号 / 机器值 ——
  { match: "BA", why: "「dBA」里的分贝单位（A 计权），是声学标准符号，只在这个组合里出现", context: /dBA/ },
  { match: "HBM", why: "HBM3 是显存标准型号（与 H.265 同类的专有名词）", context: /HBM\d/ },
  { match: "UTC", why: "UTC+8 是时区标识（数据集 `timezone` 字段值），不是可翻译的界面措辞", context: /UTC\+\d/ },

  // —— ④ 不渲染的机器可读值 / 运行时字符串 ——
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
    match: "PT",
    why: "`dateTime={`PT${秒}S`}` 里的 ISO-8601 时长前缀（抹掉插值后剩下的静态部分），机器属性，不渲染",
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

function allowedIn(match: string, relative: string, text = ""): boolean {
  return ALLOWED.some(
    (entry) =>
      entry.match === match &&
      (!entry.files || entry.files.includes(relative)) &&
      (!entry.context || entry.context.test(text)),
  );
}

/**
 * 一段用户可见文本：文本内容 + 它在**被扫源码**里的起始下标。
 *
 * 存下标而不是行号，是因为一段文本可以跳行（三行模板字面量、跨行 JSX 文本节点）：
 * 行号要等命中真正落在第几个字符上才知道，所以由 `scanSourceText` 拿着整份源码的
 * `lineStarts` 现算 —— `LIVE` 于第 6 行就报第 6 行，不报开引号那一行。
 */
interface CopySegment {
  text: string;
  offset: number;
}

/**
 * 从一份**已遮蔽注释的整份源码**里取「用户可见的字符串片段」，一次词法遍历。
 *
 * 必须整份源码一次过，不能逐行：一个跨行模板字面量在首行只有开引号、中间行没有引号、
 * 末行只有闭引号 —— 逐行扫的话三行都匹配不到，整段静态文案等于不存在。这不是边角写法，
 * 本 Stage 自己改的那条副标题就是三行（`DeviceView.tsx` 的 `subtitle={`每 2 小时…（${…}）`}`），
 * 同类的还有 `EventView.tsx` 的「事件列表」「第 N–M 条 / 共 N 条」。
 *
 * 只取静态部分：模板字面量里的 `${...}` 是代码，不是文案（`${DEVICE_STREAM_TICK_SECONDS}`
 * 这种常量名大写一抓一大把，扫进去只会制造噪音）。但插值**里面**的字符串仍然是文案
 * （`${ok ? `LIVE` : "静态"}`），所以插值内容递归回本函数，而不是整段跳过。
 * 模板字面量按插值切成若干片，每片记自己的起始下标：三行副标题里的 `LIVE` 要指回它
 * 真正所在的那一行，而不是开引号那一行。
 *
 * 模块路径（`./AvUI.module.css`、`@/components/av/AvUI`）不是文案，直接跳过。
 *
 * 只管引号字面量（含 JSX 属性值）；raw JSX 文本节点由下面的 `jsxTextSegments` 负责 ——
 * 两种写法在这套 UI 里同时大量存在，两层缺一不可。
 */
function literalSegments(source: string, baseOffset = 0): CopySegment[] {
  const out: CopySegment[] = [];
  const push = (text: string, start: number) => {
    if (!text.trim()) return;
    if (/^(@\/|\.{1,2}\/)/.test(text)) return;
    out.push({ text, offset: baseOffset + start });
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"') {
      const start = index;
      let text = "";
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          text += source[index] + (source[index + 1] ?? "");
          index += 2;
          continue;
        }
        if (source[index] === char) break;
        text += source[index];
        index += 1;
      }
      index += 1; // 跳过闭合引号
      push(text, start);
      continue;
    }
    if (char === "`") {
      index += 1;
      let chunkStart = index;
      let text = "";
      while (index < source.length) {
        if (source[index] === "\\") {
          text += source[index] + (source[index + 1] ?? "");
          index += 2;
          continue;
        }
        if (source[index] === "`") break;
        if (source[index] === "$" && source[index + 1] === "{") {
          push(text, chunkStart);
          // 插值里可以再起字符串、再起模板（`${ok ? `LIVE` : "静态"}`），递归取。
          // 递归传的是「外层切片起点 + 本片起点」，所以偏移量始终是相对被扫源码的。
          const end = skipBracedExpression(source, index + 1);
          const innerStart = index + 2;
          if (end - 1 > innerStart) {
            out.push(
              ...literalSegments(
                source.slice(innerStart, end - 1),
                baseOffset + innerStart,
              ),
            );
          }
          index = end;
          chunkStart = index;
          text = "";
          continue;
        }
        text += source[index];
        index += 1;
      }
      push(text, chunkStart);
      index += 1; // 跳过闭合反引号
      continue;
    }
    index += 1;
  }
  return out;
}

// ———————————————————————— raw JSX 文本节点 ————————————————————————

/**
 * `>` 与 `<` 之间、不在标签属性里、也不是 `{…}` 表达式的文本节点。
 *
 * 为什么要专门一段状态机，而不是「拿正则扫 `<\w+>([^<]*)<`」：
 *   · 标签属性里也有 `"` / `>`（`title="a > b"`、`onClick={() => go()}`），
 *     正则会把属性当成文本抓进来；
 *   · 文本节点里夹着 `{…}` 表达式（`<h3>{view.count} 记录</h3>`），
 *     表达式里的大写常量名不是文案；
 *   · 文本节点可以跨行、可以嵌在另一个元素里。
 *
 * 输入是**已遮蔽注释**的整份源码（`maskComments` 保留换行与字符串内容）：
 * 换行位置与原文件一一对应，所以行号可以直接指回源文件。
 *
 * 帧栈：`code`（普通 TS）→ `jsx`（children）→ `expr`（children 里的 `{…}`，
 * 表达式内部可以再起 JSX，也可以再有对象字面量的 `{}`，所以它单独成帧、自己数括号）。
 * 开标签入 `jsx` 帧、自闭合不入、闭标签出栈，这样嵌套元素各算各的文本。
 *
 * 只在「`<` 看起来真的是 JSX」时才进栈：比较运算（`i < n`）、泛型（`Map<string, number>`）
 * 的 `<` 前面是一个标识符，而 JSX 的 `<` 前面是 `(` / `return` / `=>` / `?` / `:` 这类
 * 表达式起始符。不这么卡的话，一个 `if (a < b)` 会凭空产生一整段「文本」，守卫开始冤报。
 *
 * 标签**属性里的** `{…}` 不整段跳过：`aside={<span>PERSON</span>}` 这种写法在本仓库有
 * 10+ 处（`CapabilityView.tsx` / `DeviceView.tsx` / `MonitorView.tsx`），属性里的 JSX
 * children 同样是上屏文案。`readJsxTag` 把每段属性表达式的区间带回来，这里对每段递归 ——
 * 属性里的**字符串**不靠这里（字面量那一层是全文扇出的平扫，本来就盖得到）。
 */
function jsxTextSegments(source: string, baseOffset = 0): CopySegment[] {
  const out: CopySegment[] = [];
  const stack: Array<"code" | "jsx" | "expr"> = ["code"];
  // 标签属性表达式里的 JSX children：递归扫描（区间是相对当前 `source` 的）
  const scanAttributeExpressions = (tag: JsxTag) => {
    for (const [start, end] of tag.attributeExprs) {
      if (end > start) out.push(...jsxTextSegments(source.slice(start, end), baseOffset + start));
    }
  };
  let index = 0;
  while (index < source.length) {
    const state = stack[stack.length - 1];
    const char = source[index];

    if (state === "jsx") {
      if (char === "<") {
        const tag = readJsxTag(source, index);
        if (tag) {
          scanAttributeExpressions(tag);
          if (tag.closing) {
            if (stack.length > 1) stack.pop();
          } else if (!tag.selfClosing) {
            stack.push("jsx");
          }
          index = tag.end;
          continue;
        }
        index += 1;
        continue;
      }
      if (char === "{") {
        stack.push("expr");
        index += 1;
        continue;
      }
      let end = index;
      while (end < source.length && source[end] !== "<" && source[end] !== "{") end += 1;
      const text = source.slice(index, end);
      if (text.trim()) out.push({ text, offset: baseOffset + index });
      index = end;
      continue;
    }

    // `code` / `expr`：跳过字符串；`expr` 还要自己数 `{}` 才知道何时回到 children
    if (char === "'" || char === '"' || char === "`") {
      index = skipStringLiteral(source, index);
      continue;
    }
    if (state === "expr") {
      if (char === "{") {
        stack.push("expr");
        index += 1;
        continue;
      }
      if (char === "}") {
        stack.pop();
        index += 1;
        continue;
      }
    }
    if (char === "<" && looksLikeJsxStart(source, index)) {
      const tag = readJsxTag(source, index);
      if (tag) {
        scanAttributeExpressions(tag);
        if (!tag.closing && !tag.selfClosing) stack.push("jsx");
        index = tag.end;
        continue;
      }
    }
    index += 1;
  }
  return out;
}

/** 每一行的起始下标（供二分查行号）。 */
function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

/** 下标 → 行号（1 起）。 */
function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** 跳过字符串字面量（`\` 转义照算），返回闭合引号之后的下标。 */
function skipStringLiteral(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

/** 读一个 JSX 标签（`<` 到配对的 `>`），跳过属性里的字符串与 `{…}`；读不到返回 null。 */
/**
 * 一个 JSX 标签读出来的信息。
 *
 * `attributeExprs` 是属性里每一段 `{…}` 的**内容**区间（不含大括号）：
 * `aside={<span>人员</span>}` 带回来的是 `<span>人员</span>` 那一段。
 */
interface JsxTag {
  end: number;
  closing: boolean;
  selfClosing: boolean;
  attributeExprs: Array<[start: number, end: number]>;
}

/**
 * 读一个 JSX 标签（`<` 到配对的 `>`），跳过属性里的字符串；读不到返回 null。
 *
 * 属性里的 `{…}` 不再**整段丢掉**，而是把区间记下来 —— 里面的 JSX children 也是文案。
 */
function readJsxTag(source: string, start: number): JsxTag | null {
  let index = start + 1;
  const closing = source[index] === "/";
  if (closing) index += 1;
  while (index < source.length && /[A-Za-z0-9_.\-:$]/.test(source[index])) index += 1;
  let lastSignificant = "";
  const attributeExprs: Array<[number, number]> = [];
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"') {
      index = skipStringLiteral(source, index);
      continue;
    }
    if (char === "{") {
      const end = skipBracedExpression(source, index);
      attributeExprs.push([index + 1, end - 1]);
      index = end;
      continue;
    }
    if (char === ">") {
      return {
        end: index + 1,
        closing,
        selfClosing: !closing && lastSignificant === "/",
        attributeExprs,
      };
    }
    if (!/\s/.test(char)) lastSignificant = char;
    index += 1;
  }
  return null;
}

/** 跳过一个 `{…}` 表达式（含嵌套括号与内部字符串），返回闭合 `}` 之后的下标。 */
function skipBracedExpression(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"' || char === "`") {
      index = skipStringLiteral(source, index);
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth <= 0) return index + 1;
    }
    index += 1;
  }
  return source.length;
}

/** JSX 的 `<` 前面允许出现的记号（表达式起始符）。 */
const JSX_LEAD_IN = "([{,=>&|?:;";
/** 前面是关键字时，`<` 也是 JSX（`return <div>` / `cond ? <A/> : <B/>`）。 */
const JSX_LEAD_IN_WORDS = ["return", "yield", "await", "case", "default", "else", "do", "in", "of"];

/**
 * 这个 `<` 是 JSX 的开标签，还是比较运算 / 泛型的尖括号？
 *
 * 只看前一个有效字符：`(` / `return` / `=>` / `?` 之后是 JSX；`i < n`、
 * `Map<string, number>` 这种前面是标识符的不是。宁可漏判（那种写法本来就少）
 * 也不要误判 —— 误判会让守卫在纯代码上冤报，守卫一旦吵就没人看了。
 */
function looksLikeJsxStart(source: string, index: number): boolean {
  const next = source[index + 1] ?? "";
  if (next === ">") return true;
  if (!/[A-Za-z]/.test(next)) return false;
  let back = index - 1;
  while (back >= 0 && /\s/.test(source[back])) back -= 1;
  if (back < 0) return true;
  const previous = source[back];
  if (JSX_LEAD_IN.includes(previous)) return true;
  if (!/[A-Za-z_$]/.test(previous)) return false;
  let wordStart = back;
  while (wordStart >= 0 && /[A-Za-z0-9_$]/.test(source[wordStart])) wordStart -= 1;
  return JSX_LEAD_IN_WORDS.includes(source.slice(wordStart + 1, back + 1));
}

/**
 * 取一个字符串里的**全部**英文命中。
 *
 * 每种模式都要遍历完所有非重叠命中 —— 只取第一处的话，`AV-MIC-S6 · LIVE` 会因为
 * `AV` 加过白而整串通过，`MIC` / `LIVE` 根本没被检查过，白名单契约等于可以绕过。
 *
 * 模式常量本身不带 `g`（上面几条断言直接用 `test()`），这里按次派生带 `g` 的副本，
 * 避免共享 `lastIndex` 造成跨调用的状态泄漏。
 *
 * locale code 命中时不再报它内部的大写段（`zh-CN` 里的 `CN`）：
 * 同一个东西报两次只会让白名单越写越长。
 *
 * 带下标一起返回：一段文本可以跳行（三行模板字面量、跨行 JSX 文本节点），
 * 行号得靠命中在段内的位置算出来，不能拿段首的行号充数。
 */
function matchesWithIndex(text: string): Array<{ value: string; index: number }> {
  const found: Array<{ value: string; index: number }> = [];
  for (const pattern of PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    let hit = global.exec(text);
    while (hit) {
      const value = hit[0];
      if (value && !found.some((item) => item.value.includes(value))) {
        found.push({ value, index: hit.index });
      }
      // 零宽命中（当前几条模式都不是，但别让守卫在有人加模式时死循环）
      if (hit.index === global.lastIndex) global.lastIndex += 1;
      hit = global.exec(text);
    }
  }
  return found;
}

/** 只关心「命中了什么」的地方用这个（自测里大量直接用）。 */
function matchesOf(text: string): string[] {
  return matchesWithIndex(text).map((item) => item.value);
}

/**
 * 扫一份源码文本（`relative` 只用于白名单匹配与报错定位）。
 *
 * 与 `scanSource` 拆开是为了让用例能直接喂一段字符串 —— 否则「`<th>CPU</th>` 必须红」
 * 这类负向自测只能靠往真文件里注入，写完还得记得恢复。
 */
function scanSourceText(relative: string, raw: string): Offender[] {
  const masked = maskComments(raw);
  const lineStarts = lineStartsOf(masked);
  // 两层都要：字符串字面量（含 JSX 属性值，**整份源码一次词法遍历**，可以跨行）
  // 与 raw JSX 文本节点（同样整份文件取，可以跨行）。
  const segments: CopySegment[] = literalSegments(masked);
  // JSX 文本节点只存在于 `.tsx`：`.ts` 里的 `a < b` 没必要过那套状态机。
  if (relative.endsWith(".tsx")) segments.push(...jsxTextSegments(masked));

  const offenders: Offender[] = [];
  for (const segment of segments) {
    for (const hit of matchesWithIndex(segment.text)) {
      if (allowedIn(hit.value, relative, segment.text)) continue;
      offenders.push({
        file: relative,
        // 命中在段内的下标 → 段在文件里的起始下标 → 行号
        line: lineAt(lineStarts, segment.offset + hit.index),
        snippet: segment.text.trim().slice(0, 100),
        match: hit.value,
      });
    }
  }
  return offenders;
}

function scanSource(file: string): Offender[] {
  return scanSourceText(relativeOf(file), readFileSync(file, "utf8"));
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
      if (allowedIn(value, relative, text)) continue;
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
    // 路由层的标题 / 空态提示也是直接上屏的文案：本 Stage 自己就改过这一页的 hint
    assert.ok(
      relatives.includes("app/stream-monitor/audio/page.tsx"),
      "路由层 leak 了：`app/stream-monitor` 必须在扫描根里",
    );
    assert.ok(
      relatives.some((file) => file.startsWith("app/stream-monitor/")),
      "`app/stream-monitor` 一个文件都没扫到",
    );
    assert.ok(!relatives.includes("components/av/pages/StressView.tsx"), "内部校验页不在范围内");
    assert.ok(
      !relatives.some((file) => file.includes("%5F%5Fstress")),
      "`__stress` 路由页同样不在范围内",
    );
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

  it("同一字符串里的每一处英文命中都要检查，不能只查第一处", () => {
    // 型号后面跟英文状态：`AV` 加过白，`MIC` / `LIVE` 也必须被抓到
    assert.deepEqual(matchesOf("AV-MIC-S6 · LIVE"), ["AV", "MIC", "LIVE"]);
    assert.deepEqual(matchesOf("AV-CAM-PTZ · OFFLINE"), ["AV", "CAM", "PTZ", "OFFLINE"]);
    // 多个互不相同的命中都要出现（不是只取第一个就跳下一个模式）
    assert.deepEqual(matchesOf("RSSI 与 CPU 同屏"), ["RSSI", "CPU"]);
    // 同一模式的多处命中也要全部出现
    assert.deepEqual(matchesOf("LIVE / OFFLINE"), ["LIVE", "OFFLINE"]);
    assert.deepEqual(matchesOf("P90 与 P50"), ["P90", "P50"]);

    // 白名单不能把「型号 + 英文」整串放过：逐串判定
    const line = "AV-MIC-S6 · LIVE";
    const leaked = matchesOf(line).filter(
      (value) => !allowedIn(value, "components/av/pages/MonitorView.tsx", line),
    );
    assert.deepEqual(leaked, ["LIVE"], "`LIVE` 必须透过白名单漏出来才会变红");
  });

  it("编号类白名单只覆盖编号形状，散文里的同名英文仍然变红", () => {
    const idText = "OTA-1001-1";
    assert.deepEqual(matchesOf(idText), ["OTA"]);
    assert.equal(allowedIn("OTA", "public/stream-monitor-data/devices.json", idText), true);

    // /event 的 incident.title 原样上屏：这类散文标题不许借编号前缀蒙混过关
    const prose = "OTA 批量升级：1楼讯问室 08 等 22 台终端升至 v3.9.2";
    assert.deepEqual(matchesOf(prose), ["OTA"]);
    assert.equal(
      allowedIn("OTA", "public/stream-monitor-data/incidents.json", prose),
      false,
      "`OTA` 出现在散文标题里必须变红（白名单只放行 OTA-\\d+-\\d+）",
    );
  });

  it("白名单每条都写了理由，且文件范围真实存在", () => {
    for (const entry of ALLOWED) {
      assert.ok(entry.why.length >= 6, `白名单「${entry.match}」缺少像样的理由`);
      for (const file of entry.files ?? []) {
        assert.ok(existsSync(resolve(process.cwd(), file)), `白名单指向了不存在的文件：${file}`);
      }
    }
    // 例外集合与白名单表必须一一对应：写在集合里但表里没条目 = 空承诺
    // （用 `Array.from` 而不是 `for…of`：根 tsconfig 没有显式 target，`downlevelIteration` 会把
    // Set 的迭代挡下来 —— 与文件头注释里 `matchAll` 那一条同一个原因。）
    Array.from(SHAPE_EXEMPT).forEach((match) => {
      assert.ok(
        ALLOWED.some((entry) => entry.match === match),
        `例外集合里的「${match}」在白名单表里没有条目`,
      );
    });
  });

  it("白名单契约：除显式例外集合外，每条都必须带形状（context / files）", () => {
    const bare = ALLOWED.filter(
      (entry) => !entry.context && !entry.files && !SHAPE_EXEMPT.has(entry.match),
    ).map((entry) => entry.match);
    assert.deepEqual(
      bare,
      [],
      `这些白名单既没有 context/files，也不在 SHAPE_EXEMPT 里 —— 散文里的同名英文会借它蒙混过关：${bare.join(" / ")}`,
    );
  });

  it("编号 / 型号前缀整表带形状：散文里的同名英文一律变红，编号形状放行", () => {
    // 一句话：`MIC` 只有在 `AV-MIC-S6` 里才是型号，`MIC 通道信号质量` 是散文。
    // 上一轮只收紧了 `OTA` / `PTZ`，剩下的前缀全是裸 `match`，两张注入实测都绿 ——
    // 所以这里把整张表逐条跑一遍，免得下一轮再冒出一个漏网的前缀。
    const cases: Array<[match: string, prose: string, shaped: string]> = [
      ["AV", "AV 接口极性反接", "AV-MIC-S6"],
      ["MIC", "MIC 通道信号质量", "AV-MIC-S8-1001"],
      ["CAM", "CAM 通道离线", "AV-CAM-360"],
      ["GW", "GW 出口带宽", "AV-GW-200-2004"],
      ["PT", "PT 点位通道信号质量", "PT-B1-1F01"],
      ["AL", "AL 阈值下调", "AL-00037"],
      ["EV", "EV 事件归档", "EV-20260145"],
      ["IP", "IP 地址冲突", "IP-00008"],
      ["DO", "DO 一次整机复位", "DO-0045"],
      ["OT", "OT 升级窗口", "OT-0038"],
      ["CF", "CF 阈值回滚", "CF-0002"],
      ["MR", "MR 现场补录", "MR-0001"],
      ["FP", "FP 相似度复核", "FP-0031"],
      ["WO", "WO 工单派发", "WO-20261019-011"],
      ["OTA", "OTA 批量升级：1 楼讯问室", "OTA-1001-1"],
      ["PTZ", "PTZ 云台自动跟随", "AV-CAM-PTZ"],
    ];
    const data = "public/stream-monitor-data/incidents.json";
    const missed: string[] = [];
    for (const [match, prose, shaped] of cases) {
      assert.deepEqual(matchesOf(prose), [match], `样本没命中「${match}」`);
      assert.equal(
        allowedIn(match, data, prose),
        false,
        `「${match}」在散文「${prose}」里被放行了 —— 它的白名单没有形状`,
      );
      if (!allowedIn(match, data, shaped)) missed.push(`${match} ⇎ ${shaped}`);
    }
    assert.deepEqual(missed, [], "编号 / 型号形状被错拦了，白名单写得太紧");
  });

  it("楼栋编码两种形状都对：`PT-SS-1F01` 与 `sites[].code` 原值放行，散文里的 `SS` 变红", () => {
    assert.equal(
      allowedIn("SS", "public/stream-monitor-data/alarms/shard-000.json", "PT-SS-1F01 告警"),
      true,
      "点位编号里的站点段必须放行（数据集里 400 多处）",
    );
    assert.equal(
      allowedIn("SS", "public/stream-monitor-data/sites.json", "SS"),
      true,
      "`sites[].code` 原值是机器可读字段",
    );
    assert.equal(
      allowedIn("SS", "components/av/pages/MonitorView.tsx", "SS 站点在线率"),
      false,
      "界面文案里的 `SS` 不是在编号形状里，必须变红",
    );
  });

  it("事件标题里的「OTA 批量升级」已按数据集中文化，没有借编号白名单漏上屏", () => {
    // 这条数据的 title 会原样渲染在 /event 的列表、表格与详情「标题」行（三处），
    // 所以中文化必须落在数据集上，而不是靠白名单放行。
    const incidents = JSON.parse(
      readFileSync(resolve(process.cwd(), PUBLIC_DATA_DIR, "incidents.json"), "utf8"),
    ) as Array<{ title?: string }>;
    const prose = incidents
      .map((item) => item.title ?? "")
      .filter((title) => /(^|[^A-Za-z])OTA(?![A-Za-z])/.test(title));
    assert.deepEqual(prose, [], "事件标题里还有「OTA」，/event 会把英文带上屏");
    assert.ok(
      incidents.some((item) => (item.title ?? "").includes("固件批量升级")),
      "固件升级类事件的标题应该已经写成中文",
    );
  });

  it("模板插值里的常量名不算文案（否则 ${DEVICE_STREAM_TICK_SECONDS} 会被误报）", () => {
    const source = '  subtitle={`每 ${DEVICE_STREAM_TICK_SECONDS} 秒刷新`},';
    // 只留下静态文本，插值部分（常量名）被抹掉；插值两侧各成一片
    assert.deepEqual(
      literalSegments(source).map((segment) => segment.text),
      ["每 ", " 秒刷新"],
    );
    assert.equal(UPPER_RUN.test(literalSegments(source).map((segment) => segment.text).join("")), false);
  });

  // —— 跨行字面量（阻塞 5）————————————————————————————————————————

  it("跨行模板字面量的静态文本也是文案：三行副标题里回填 `LIVE` 必须变红", () => {
    // 本 Stage 自己改过的副标题就是这个形状（`DeviceView.tsx` 的在线率趋势面板），
    // 逐行扫的话首行只有开引号、中间行没有引号、末行只有闭引号 —— 三行都扫不到。
    const reverted = [
      "export function Panel() {",
      "  return (",
      "    <AvPanel",
      '      title="近 24 小时在线率趋势"',
      "      subtitle={`每 2 小时一个采样点 · 末端为当前值（${",
      '        motionEnabled ? `LIVE 每 30 秒刷新` : "静态模式"',
      "      }）`}",
      "    />",
      "  );",
      "}",
    ].join("\n");
    assert.deepEqual(
      scanSourceText("components/av/pages/DeviceView.tsx", reverted).map(
        (item) => `${item.line}: [${item.match}]`,
      ),
      // 行号指向命中真正所在的那一行（第 6 行），不是开引号那一行
      ["6: [LIVE]"],
    );

    // 当前仓库的真实写法（副标题三行、内部全是中文）必须绿
    const current = reverted.replace("LIVE 每 30 秒刷新", "每 30 秒刷新");
    assert.deepEqual(scanSourceText("components/av/pages/DeviceView.tsx", current), []);
  });

  it("逐行扫不到的三行字面量（无插值）现在也扫得到", () => {
    // 最朴素的一条：模板里没有任何 `${}`，纯粹因为换行而逐行扫不到
    const source = ['const note = `第一行', "RSSI 第二行", "第三行`;"].join("\n");
    assert.deepEqual(
      scanSourceText("lib/av/view.ts", source).map((item) => `${item.line}: [${item.match}]`),
      ["2: [RSSI]"],
    );
    // 单引号 / 双引号里的转义不再让整串变得不可见（旧正则把带 `\\` 的串整段跳过了）
    assert.deepEqual(
      scanSourceText("lib/av/view.ts", 'const s = "罚单 LIVE\\n";').map(
        (item) => `${item.match}`,
      ),
      ["LIVE"],
    );
  });

  it("字面量扫得到东西（不是空跑）", () => {
    const texts = SOURCE_FILES.flatMap((file) =>
      literalSegments(maskComments(readFileSync(file, "utf8"))).map((segment) => segment.text),
    );
    assert.ok(texts.length > 500, `只取到 ${texts.length} 段字面量，词法遍历大概率没进字符串`);
    // 本 Stage 改的三行副标题必须被取到（旧逐行实现拿不到这一段）
    assert.ok(
      texts.some((text) => text.includes("每 2 小时一个采样点")),
      "跨行副标题的静态文本没被取到",
    );
  });

  // —— raw JSX 文本节点（阻塞 4）————————————————————————————————————————

  it("raw JSX 文本节点也是文案：`<th>CPU</th>` 必须变红", () => {
    const file = "components/av/pages/DeviceView.tsx";
    // 本 Stage 把表头从 `CPU` 改成了「处理器占用」；回填必须被拦住
    const reverted = `export function Cols() {\n  return (\n    <tr>\n      <th className={s.num}>CPU</th>\n    </tr>\n  );\n}\n`;
    assert.deepEqual(
      scanSourceText(file, reverted).map((item) => `${item.line}: [${item.match}]`),
      ["4: [CPU]"],
    );

    // 中文版本（当前仓库的真实写法）必须绿
    const current = `export function Cols() {\n  return (\n    <tr>\n      <th className={s.num}>处理器占用</th>\n    </tr>\n  );\n}\n`;
    assert.deepEqual(scanSourceText(file, current), []);
  });

  it("JSX 状态机只取文本节点：标签属性与 `{…}` 表达式不算文案", () => {
    const source = [
      "export function Panel() {",
      "  return (",
      '    <AvPanel title="固件升级" subtitle={view.windowLabel} icon="alarm">',
      "      <h3>{VIEW_COUNT} 记录</h3>",
      "      <span>中位</span>",
      "      <br />",
      "    </AvPanel>",
      "  );",
      "}",
    ].join("\n");
    const texts = jsxTextSegments(maskComments(source)).map((segment) => segment.text.trim());
    // 属性（`title` / `subtitle` / `icon`）与表达式里的常量名（`VIEW_COUNT`）都不该进来
    assert.deepEqual(texts, ["记录", "中位"]);
    // 表达式里的常量名是代码，不产生 offender；属性值则由字符串字面量那一层负责
    assert.deepEqual(scanSourceText("components/av/pages/DeviceView.tsx", source), []);
  });

  it("标签属性里的 JSX children 也扫：`aside={<span>PERSON</span>}` 不再是盲区", () => {
    const source = [
      "export function Panel() {",
      "  return (",
      "    <AvPageHeader",
      '      title="能力与场景"',
      "      aside={<span className={s.chip}>PERSON 算法</span>}",
      "      meta={<span>{count} 个站点</span>}",
      "    />",
      "  );",
      "}",
    ].join("\n");
    assert.deepEqual(
      scanSourceText("components/av/pages/CapabilityView.tsx", source).map(
        (item) => `${item.line}: [${item.match}]`,
      ),
      ["5: [PERSON]"],
    );
    // 属性里的文本节点真的被取到了（不是空扫）：本仓库的 `aside` / `meta` 写法就是这一种
    const texts = jsxTextSegments(maskComments(source)).map((segment) => segment.text.trim());
    assert.deepEqual(texts, ["PERSON 算法", "个站点"]);

    // 仓库里的真实写法（`CapabilityView.tsx` 的 `aside={<span>… 个算法 · … 显存</span>}`）必须绿
    const real = [
      "export function Panel() {",
      "  return (",
      "    <AvPageHeader",
      '      title="能力与场景"',
      "      aside={<span className={s.chip}>{formatCount(totals.algorithms)} 个算法 · {formatGb(totals.vram)} 显存</span>}",
      "    />",
      "  );",
      "}",
    ].join("\n");
    assert.deepEqual(
      jsxTextSegments(maskComments(real)).map((segment) => segment.text.trim()),
      ["个算法 ·", "显存"],
    );
    assert.deepEqual(scanSourceText("components/av/pages/CapabilityView.tsx", real), []);
  });

  it("比较运算 / 泛型的尖括号不会被当成 JSX 文本", () => {
    const source = [
      "export function pick(rows: Row[], index: number) {",
      "  const table = new Map<string, number>();",
      "  const over = index < rows.length && rows.length > 0;",
      "  if (index < rows.length) return rows[index];",
      "  return over ? rows[0] : null;",
      "}",
    ].join("\n");
    assert.deepEqual(jsxTextSegments(maskComments(source)), []);
  });

  it("路由层（`app/stream-monitor`）的文案也在射程内", () => {
    const file = "app/stream-monitor/audio/page.tsx";
    // 上报的注入点：路由文件里的空态 hint
    const injected = `export default function P() {\n  return <AvEmpty title="没有可分析的音频" hint="LIVE 预览不可用" />;\n}\n`;
    assert.deepEqual(
      scanSourceText(file, injected).map((item) => `${item.line}: [${item.match}]`),
      ["2: [LIVE]"],
    );
    // 当前仓库的真实写法（属性值也是文案，必须绿）
    const current = `export default function P() {\n  return <AvEmpty title="没有可分析的音频" hint="当前没有带频谱的告警。" />;\n}\n`;
    assert.deepEqual(scanSourceText(file, current), []);
  });

  it("raw JSX 文本节点扫得到东西（不是空跑）", () => {
    const tsx = SOURCE_FILES.filter((file) => file.endsWith(".tsx"));
    assert.ok(tsx.length > 10, `只扫到 ${tsx.length} 个 tsx，范围不对`);
    const texts = tsx.flatMap((file) =>
      jsxTextSegments(maskComments(readFileSync(file, "utf8"))).map((segment) => segment.text.trim()),
    );
    assert.ok(texts.length > 100, `只取到 ${texts.length} 段 JSX 文本，状态机大概率没进 children`);
    // 本 Stage 改的典型位置（表头 / 台账列名）恰好都是 raw JSX children：
    const labels = texts.filter((text) => /^[\u4e00-\u9fa5]{2,}$/.test(text));
    assert.ok(labels.length > 40, `只取到 ${labels.length} 条纯中文标签，状态机大概率没进 children`);
    assert.ok(labels.includes("处理器占用"), "DeviceView 的表头文案没被取到");
    assert.ok(labels.includes("在线率"), "站点表的表头文案没被取到");
  });

  it("型号白名单也带形状：散文里的 `PTZ` 变红，`AV-CAM-PTZ` 放行", () => {
    const prose = "PTZ 云台自动跟随";
    assert.deepEqual(matchesOf(prose), ["PTZ"]);
    assert.equal(
      allowedIn("PTZ", "public/stream-monitor-data/devices.json", prose),
      false,
      "`PTZ` 只在 `AV-CAM-PTZ` 这种型号形状里放行",
    );
    assert.equal(allowedIn("PTZ", "public/stream-monitor-data/devices.json", "AV-CAM-PTZ"), true);
  });
});
