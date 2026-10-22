import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALARM_PAGE_SIZE } from "./alarmPaging";

/**
 * `/alarm` 首屏条数 × 行高的标定契约（BLF-1426）。
 *
 * 这个 issue 的验收标准是一条**几何等式**：
 *
 *   面板 chrome（约 160px）+ 首屏条数 × 行高 ≈ 右侧三卡栈内容高（956–972.5px）
 *
 * 等式由三个散落在不同文件里的值共同决定，任何一处单独改动都会让「左侧长龙、
 * 右侧三卡」的老问题悄悄回来：
 *   1. `ALARM_PAGE_SIZE`（lib/av/alarmPaging.ts，客户端翻页与服务端首屏共用）；
 *   2. `--av-alarm-row-h`（globals.css 的令牌）；
 *   3. `.alarmCard` / `.alarmSkeletonRow` 真的消费了这个令牌。
 *
 * 这里守的是「三者仍然是一套」，不是「行高必须是 67px」——
 * 以后要调行高，改令牌 + 条数后重跑 `scripts/av-alarm-row-calibration.mjs`，
 * 让下面的等式重新成立即可（等式里的三卡栈高度是 2026-10 的真实量距）。
 *
 * jsdom 没有布局引擎，所以几何等式不能在这里量；真机量距在
 * `scripts/av-alarm-row-calibration.mjs`（CDP，1440/1280/1180 + 两栏带下界 1160 与其下方 1159）。
 * 这里只做客单价：常量、令牌、消费点、媒体查询是否还连着。
 */

const CSS = readFileSync(resolve(process.cwd(), "components/av/pages/AvPages.module.css"), "utf8");
const GLOBALS = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

/** 取某个选择器的声明体（按花括号配平，避免 `}` 出现在值里时截错）。 */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{`).exec(css);
  if (!match) return "";
  const start = match.index + match[0].length;
  let depth = 1;
  for (let index = start; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index);
    }
  }
  return "";
}

/**
 * 实测：1440×1200 dark 下右侧三卡栈的内容高。
 *
 * BLF-1431（Stage 7）删掉「未处置分级」「告警剧本」两处说明型副标题后，三卡栈从
 * 956px 降到 915px —— 行高跟着从 67px 收到 63px，等式重新成立。
 * 数值来自 `scripts/av-alarm-row-calibration.mjs` 的 `railContentBottom`
 * （2026-10-21，1440 / 1280 / 1180 / 1160 四档实测一致，底边差 1px）。
 */
const RAIL_CONTENT_HEIGHT_1440 = 915;
/** 实测：面板 chrome（头 + 工具条 + 底栏 + 内边距）加上列表上边距，合计 160px。 */
const PANEL_CHROME_HEIGHT = 160;
/** 验收允许的底边差。 */
const ALIGN_TOLERANCE_PX = 12;

describe("/alarm 行高标定（BLF-1426）", () => {
  it("首屏条数是 12，且只有一个真源", () => {
    expect(ALARM_PAGE_SIZE).toBe(12);
  });

  it("行高令牌与首屏条数满足标定等式（1440 档）", () => {
    const match = /--av-alarm-row-h:\s*(\d+)px;/.exec(GLOBALS);
    expect(match, "globals.css 缺少 --av-alarm-row-h").not.toBeNull();
    const rowHeight = Number(match![1]);
    // BLF-1431 起行高是 63px（右栏删掉两条说明型副标题后重标定）
    const panelHeight = PANEL_CHROME_HEIGHT + ALARM_PAGE_SIZE * rowHeight;
    expect(
      Math.abs(panelHeight - RAIL_CONTENT_HEIGHT_1440),
      `面板高 ${panelHeight}px 与三卡栈 ${RAIL_CONTENT_HEIGHT_1440}px 差超过 ±${ALIGN_TOLERANCE_PX}px：` +
        `改条数或行高后请重跑 scripts/av-alarm-row-calibration.mjs 并同步这里`,
    ).toBeLessThanOrEqual(ALIGN_TOLERANCE_PX);
  });

  it("告警行与骨架行消费同一个行高令牌，且只作用于 /alarm", () => {
    const card = ruleBody(CSS, '.page[data-av-page="alarm"] .alarmCard');
    expect(card, "缺少 /alarm 专用的 .alarmCard 行高规则").not.toBe("");
    expect(card).toMatch(/min-height:\s*var\(--av-alarm-row-h\);/);

    const skeleton = ruleBody(CSS, ".alarmSkeletonRow");
    expect(skeleton).toMatch(/height:\s*var\(--av-alarm-row-h\);/);

    // __stress 也复用 .alarmCard，不能把行高钉死在那里
    const baseCard = ruleBody(CSS, ".alarmCard");
    expect(baseCard).not.toMatch(/min-height:/);
  });

  it("行内 facts 压成单行 + ellipsis，不允许硬裁", () => {
    const facts = ruleBody(CSS, '.page[data-av-page="alarm"] .alarmFacts');
    expect(facts).toMatch(/flex-wrap:\s*nowrap;/);
    expect(facts).toMatch(/overflow:\s*hidden;/);
    const cells = ruleBody(CSS, '.page[data-av-page="alarm"] .alarmFacts > span');
    expect(cells).toMatch(/text-overflow:\s*ellipsis;/);
    expect(cells).toMatch(/white-space:\s*nowrap;/);
  });

  it("两栏带不再从 901 起：下界抬到面板装得下自己工具条与标题的宽度", () => {
    // Codex P2 on PR #175：901 下界时内容区 901 − 220 − 40 = 641，减 gap 12 与右栏
    // minmax(300px, 1fr) 的 300 后左面板只剩 329px —— 标题被压成省略号；
    // 而 900 是单栏、标题近 580px，900 → 901 是一道断崖。
    // 实测 1100 也不够：面板 528px 时装不下工具条（搜索 min 180 + 场景 Tabs），
    // .alarmToolbar 38 → 76px，底边差 −8.5 → +29.5；临界在 1150/1151，故取 1160。
    const match =
      /@media\s*\(min-width:\s*(\d+)px\)\s*and\s*\(max-width:\s*1180px\)\s*\{[^}]*\.page\[data-av-page="alarm"\]\s+\.splitWide\s*\{/.exec(
        CSS,
      );
    expect(match, "缺少 /alarm 在 1180 的两栏覆盖").not.toBeNull();
    const minWidth = Number(match![1]);
    expect(minWidth, "901 下界已废弃：那一档左面板只有 329px").toBeGreaterThan(901);
    expect(minWidth, "1180 必须仍在两栏带内").toBeLessThanOrEqual(1180);

    // 量距脚本的下界必须与这条媒体查询是同一个数，否则实测证明的不是上线的那一档。
    const script = readFileSync(resolve(process.cwd(), "..", "scripts", "av-alarm-row-calibration.mjs"), "utf8");
    const declared = /const TWO_COLUMN_MIN_WIDTH = (\d+);/.exec(script);
    expect(declared, "脚本缺少 TWO_COLUMN_MIN_WIDTH").not.toBeNull();
    expect(Number(declared![1])).toBe(minWidth);
    expect(script).toMatch(/const REQUIRED_WIDTHS = \[1440, 1280, 1180, TWO_COLUMN_MIN_WIDTH\];/);
    // 下界下方 1px 必须仍被量到，且必须是单栏 —— 档口两侧都要可用。
    expect(script).toMatch(/const BAND_PROBE_WIDTHS = \[TWO_COLUMN_MIN_WIDTH - 1\];/);
  });

  it("量距脚本单独断言栏数、标题与告警编号没被压成省略号", () => {
    const script = readFileSync(resolve(process.cwd(), "..", "scripts", "av-alarm-row-calibration.mjs"), "utf8");
    // 标题带 ellipsis，被压窄时既不溢出也不裁字：clipped 抓不到，必须量 scrollWidth。
    expect(script).toMatch(/truncatedTitles:\s*truncatedCount\(titleCells\)/);
    expect(script).toMatch(/truncatedNumbers:\s*truncatedCount\(numberCells\)/);
    expect(script).toMatch(/entry\.truncation\.truncatedTitles > 0/);
    expect(script).toMatch(/entry\.truncation\.truncatedNumbers > 0/);
    // 「没被省略」不够：标题列还得有可用宽度（样例标题很短，40px 也能恰好排下）。
    expect(script).toMatch(/const MIN_TITLE_WIDTH_PX = 200;/);
    expect(script).toMatch(/entry\.truncation\.titleMinWidth < MIN_TITLE_WIDTH_PX/);
    // 栏数：下界及以上两栏、下界下方 1px 单栏。
    expect(script).toMatch(/entry\.columnCount !== 2/);
    expect(script).toMatch(/entry\.columnCount !== 1/);
  });

  it("量距脚本用面板自然底边算底边差（不能让 splitWide 的拉伸把判定变成恒真）", () => {
    const script = readFileSync(resolve(process.cwd(), "..", "scripts", "av-alarm-row-calibration.mjs"), "utf8");
    expect(script).toMatch(/panelNaturalBottom:\s*round\(panelRect\.top \+ panelNaturalHeight\)/);
    expect(script).toMatch(/deltaPanelRail:\s*round\(panelRect\.top \+ panelNaturalHeight - railContentBottom\)/);
    // 1280/1180 时左面板被 splitWide 的 height:100% 拉到与 railStack 同高，
    // 用盒子 rect 相减差值恒为 0：行高失控也照样「通过」。
    expect(script, "deltaPanelRail 不能直接用被拉伸的 panelRect.bottom").not.toMatch(/deltaPanelRail:\s*round\(panelRect\.bottom/);
  });

  it("服务端首屏、客户端翻页、server 默认值引用同一个常量", () => {
    const pageData = readFileSync(resolve(process.cwd(), "lib/av/pageData.ts"), "utf8");
    const server = readFileSync(resolve(process.cwd(), "lib/av/server.ts"), "utf8");
    const view = readFileSync(resolve(process.cwd(), "components/av/pages/AlarmView.tsx"), "utf8");

    expect(pageData).toMatch(/import\s*\{\s*ALARM_PAGE_SIZE\s*\}\s*from\s*"\.\/alarmPaging";/);
    expect(pageData).toMatch(/getAlarmPage\(null,\s*ALARM_PAGE_SIZE\)/);
    expect(pageData, "pageData 里不应再出现写死的首屏条数 50").not.toMatch(/getAlarmPage\(null,\s*50\)/);

    expect(server).toMatch(/import\s*\{\s*ALARM_PAGE_SIZE\s*\}\s*from\s*"\.\/alarmPaging";/);
    expect(server).toMatch(/pageSize\s*=\s*ALARM_PAGE_SIZE/);

    expect(view).toMatch(/import\s*\{\s*ALARM_PAGE_SIZE\s*\}\s*from\s*"@\/lib\/av\/alarmPaging";/);
    expect(view).toMatch(/loadAlarmPage\(props\.index,\s*cursor,\s*ALARM_PAGE_SIZE\)/);
    expect(view).toMatch(/每页\s*\$\{ALARM_PAGE_SIZE\}\s*条/);
    expect(view, "AlarmView 里不应再有本地 PAGE_SIZE 常量").not.toMatch(/const PAGE_SIZE\s*=/);
  });
});
