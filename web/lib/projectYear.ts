/**
 * 项目年度筛选的纯逻辑（BLF-1149，可单测）。
 *
 * 后端没有独立的 `year` 参数，但项目编号统一为 `PJ-{年份}-{序号}`（见
 * `api/routers/projects.py::_next_code`），且 `GET /projects` 支持 `code`
 * 模糊匹配。年度筛选因此复用既有 `code` 参数做服务端过滤：
 * 选 2026 → 传 `code=PJ-2026-`，分页 total 与列表天然一致，不做前端截断。
 *
 * 抽到 lib 的原因：编号格式与 URL 参数的解析规则同时被列表页与测试引用，
 * 散在页面里改格式时容易只改一半；这里的兼容矩阵由测试守住。
 */

/** 编号中年份的形状：`PJ-2026-0001`（序号固定 4 位，年份固定 4 位）。 */
const CODE_YEAR_RE = /^PJ-(\d{4})-\d+$/;

/** URL `?year=` 的合法形状：裸 4 位年份。 */
const YEAR_PARAM_RE = /^\d{4}$/;

/** 年度下拉最早回溯到哪一年（编号体系 2020 年前无 PJ-YYYY- 数据）。 */
export const MIN_YEAR_OPTION = 2020;

/**
 * 从项目编号派生年份：`PJ-2026-0001` → `"2026"`。
 * 用户手工录入的非标编号（无年份段）返回 `""`，调用方按「无年份」处理。
 */
export function extractProjectYear(code: string | null | undefined): string {
  if (!code) return "";
  const m = String(code).trim().match(CODE_YEAR_RE);
  return m ? m[1] : "";
}

/**
 * 解析 URL 中的 `?year=`：合法 4 位年份原样返回，其余一律回落 `""`（全部年份）。
 * 年份不存在于下拉选项不算非法——数据年份可能超出下拉回溯范围，照常向后端
 * 发 `code` 过滤，由服务端 total 说了算。
 */
export function parseYearParam(raw: string | null | undefined): string {
  if (raw == null) return "";
  const v = String(raw).trim();
  return YEAR_PARAM_RE.test(v) ? v : "";
}

/**
 * 年份 → 后端 `code` 查询值：`"2026"` → `"PJ-2026-"`。
 * 后端按 LIKE `%PJ-2026-%` 匹配，等价于「编号年份 = 2026」。
 * 空年份返回 `""`，`buildQuery` 会自动跳过该参数（不过滤）。
 */
export function yearToCodeFilter(year: string | null | undefined): string {
  const y = parseYearParam(year);
  return y ? `PJ-${y}-` : "";
}

/**
 * 年度下拉选项（倒序：最新年份在前，与列表默认倒序一致）。
 * 范围为 `当年+1 … MIN_YEAR_OPTION`（+1 容纳跨年立项的次年编号）；
 * 当前 URL 选中的合法年份若落在范围外，追加到末尾，保证刷新/分享链接
 * 的选中态不丢（选中项不在选项里时 `<select>` 会回落显示第一项）。
 */
export function buildYearOptions(
  now: Date | number = Date.now(),
  selectedYear = "",
): string[] {
  const current = now instanceof Date ? now.getFullYear() : new Date(now).getFullYear();
  const years: string[] = [];
  for (let y = current + 1; y >= MIN_YEAR_OPTION; y--) years.push(String(y));
  const sel = parseYearParam(selectedYear);
  if (sel && !years.includes(sel)) years.push(sel);
  return years;
}
