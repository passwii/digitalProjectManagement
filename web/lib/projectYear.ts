/**
 * 项目年度筛选的纯逻辑（BLF-1149，可单测）。
 *
 * 后端没有独立的 `year` 参数，合同编号约定包含 `-{年份}-` 段（例如
 * `SHZK-2026-009`），且 `GET /projects` 支持 `code` 模糊匹配。年度筛选因此
 * 复用既有 `code` 参数做服务端过滤：选 2026 → 传 `code=-2026-`，分页 total
 * 与列表天然一致，不做前端截断。
 *
 * 抽到 lib 的原因：编号格式与 URL 参数的解析规则同时被列表页与测试引用，
 * 散在页面里改格式时容易只改一半；这里的兼容矩阵由测试守住。
 */

/** 编号中年份的形状：任意前缀 + `-2026-` 年份段 + 后续编号。 */
const CODE_YEAR_RE = /(?:^|-)(\d{4})-/;

/** 项目年度筛选固定的可选项与合法 URL 参数。 */
export const PROJECT_YEAR_OPTIONS = ["2027", "2026", "2025", "2024", "2023"] as const;

const PROJECT_YEAR_SET: ReadonlySet<string> = new Set(PROJECT_YEAR_OPTIONS);

/**
 * 从合同编号派生年份：`SHZK-2026-009` → `"2026"`。
 * 用户手工录入的非标编号（无年份段）返回 `""`，调用方按「无年份」处理。
 */
export function extractProjectYear(code: string | null | undefined): string {
  if (!code) return "";
  const m = String(code).trim().match(CODE_YEAR_RE);
  return m ? m[1] : "";
}

/**
 * 解析 URL 中的 `?year=`：只接受固定的五个年度，其余一律回落 `""`（全部年份）。
 */
export function parseYearParam(raw: string | null | undefined): string {
  if (raw == null) return "";
  const v = String(raw).trim();
  return PROJECT_YEAR_SET.has(v) ? v : "";
}

/**
 * 年份 → 后端 `code` 查询值：`"2026"` → `"-2026-"`。
 * 后端会在这个片段外再加 `%` 组成 LIKE 模式，等价于「编号年份 = 2026」，
 * 不依赖合同编号前缀。
 * 空年份返回 `""`，`buildQuery` 会自动跳过该参数（不过滤）。
 */
export function yearToCodeFilter(year: string | null | undefined): string {
  const y = parseYearParam(year);
  return y ? `-${y}-` : "";
}

/** 年度下拉选项（固定倒序：最新年份在前，与列表默认倒序一致）。 */
export function buildYearOptions(
  now: Date | number = Date.now(),
  selectedYear = "",
): string[] {
  void now;
  void selectedYear;
  return [...PROJECT_YEAR_OPTIONS];
}
