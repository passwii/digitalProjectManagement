/**
 * 项目完整档案页的 Tab 定义与 `?tab=` 解析（纯逻辑，可单测）。
 *
 * 抽到 lib 的原因：Tab 名改动会同时影响**历史链接**与**通知深链**
 * （`/projects/1?tab=白板`、`?tab=跟进` 等），这种「旧值必须仍然可用」的兼容
 * 规则最容易在页面文件里被顺手删掉，且删掉后没有任何测试会红。放在这里，
 * 改名时的兼容矩阵由测试守住。
 */

/** 档案页全部 Tab（顺序即展示顺序）。 */
export const PROJECT_TABS = ["文档", "合同", "进度", "成本", "应收", "日志"] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number];

/**
 * 旧 Tab 名 → 现行 Tab 名的折叠表。
 *
 *   · 白板 / 基本 / 附件 —— 同一块内容的历史名字，现名「文档」；
 *   · 跟进 —— 跟进表单已下线，其信息落在文档正文，深链回落到「文档」。
 *   · 支出 / 变更 —— 栏目改名后的历史深链，分别回落到「成本」/「日志」。
 */
export const LEGACY_PROJECT_TABS: Readonly<Record<string, ProjectTab>> = {
  白板: "文档",
  基本: "文档",
  附件: "文档",
  跟进: "文档",
  支出: "成本",
  变更: "日志",
};

/**
 * 解析 `?tab=` 参数。
 *
 * 缺失/无法识别落到 `文档`（档案页主 Tab）；旧名称按映射进入现行 Tab，
 * 因此改名不会让任何一个旧链接落到空白页。
 *
 * ⚠️ 折叠表用 `Object.hasOwn` 而不是 `raw in ...`：`in` 会命中原型链，
 * `?tab=constructor` / `?tab=toString` / `?tab=__proto__` 会读出 `Object.prototype`
 * 上的成员并原样返回（`Object` 构造函数 / 原生 toString / `[object Object]`），
 * 类型上不是 `ProjectTab`，页面里那几条 `tab === "文档"` 分支全不匹配 ——
 * 结果是「页签容器在、内容区全空」。这几个键在 `URLSearchParams` 里都是普通字符串，
 * 任何访问者都能构造。
 */
export function parseProjectTab(raw: string | null | undefined): ProjectTab {
  if (raw && (PROJECT_TABS as readonly string[]).includes(raw)) return raw as ProjectTab;
  // 只看自有键：原型链上的 constructor / toString / __proto__ 等都不是合法 Tab
  if (raw && Object.hasOwn(LEGACY_PROJECT_TABS, raw)) return LEGACY_PROJECT_TABS[raw];
  return "文档";
}
