# 全站自绘下拉与菜单优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 将工作台 58 处原生选择菜单替换为项目自绘下拉，修正移动端财务操作菜单和项目删除 hover，并保持现有业务行为。

**架构：** 新增共享 `Select`，通过按钮触发器与 portal listbox 绘制选项；业务页以字符串值更新现有状态。财务移动操作菜单使用与账号菜单一致的菜单语义，项目删除样式通过危险色 token 局部覆盖。

**技术栈：** Next.js 14、React 18、TypeScript、CSS Modules、React Portal；不新增组件库或运行时依赖。

## 全局约束

- 沿用控制台的直角边框、细分隔线、青色交互信号、酸橙主动作和现有深浅主题 token。
- 日期、月份、时间、文件、复选框和单选框继续使用系统控件。
- 保持业务值、URL 筛选、权限判断、字段文案、表单必填和项目删除确认流程。
- 自绘触发器和选项浮层支持键盘、触控、禁用选项、主题切换、视口翻转与减少动效。
- 代码提交标题及 Git/PR 分节使用中文；未经用户要求不新增或运行自动化测试。

---

## 文件与职责

- `web/components/ui/Select.tsx`：解析 `<option>` 子节点、管理选择状态、键盘导航、表单语义和 portal 定位。
- `web/components/ui/Select.module.css`：控制台主题及演示页主题的触发器和浮层外观。
- `web/app/globals.css`：迁移结束后清理已不再需要的原生 select 样式，并局部覆盖危险按钮 hover/focus。
- 项目、通讯录、报表、财务、成本、进度、资产、商机、管理、伙伴页面：用共享组件替换原生下拉并保持原有状态更新。
- `web/components/motion/MotionTabs.tsx`：手机页面分区选择改用共享控件，桌面 tablist 不变。
- `web/components/spark/pages/*` 与 `SparkPages.module.css`：演示页使用共享行为，并保留演示页自身颜色约定。
- `docs/superpowers/specs/2026-09-28-global-select-menu-polish-design.md`：已确认的视觉与交互契约。

### Task 1: 建立共享 Select

**文件：** 新建 `web/components/ui/Select.tsx`、`web/components/ui/Select.module.css`。

**接口：**

```tsx
type SelectProps = {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
  title?: string;
  className?: string;
  surface?: "console" | "spark";
  children: React.ReactNode;
};
```

- 递归读取 `<option>` 和 `<Fragment>` 子节点，得到 `{ value, label, disabled }[]`；缺少 `value` 时按 HTML select 规则取选项文字。
- 用 `button type="button" role="combobox"` 显示当前值，设置唯一 `aria-controls`、`aria-expanded`、`aria-activedescendant`；浮层使用 `role="listbox"`，每个条目使用 `role="option"` 与 `aria-selected`。
- 打开时默认激活当前可选项；方向键移动、Home/End 跳首尾、Enter/Space 选择、Escape 关闭、首字母检索定位，Tab 保留浏览器默认离开顺序；所有键盘操作跳过禁用项。
- 点击或触控触发器开关；点击浮层外关闭。使用 `createPortal` 将 listbox 挂到 `document.body`，以触发器矩形定位；滚动、缩放和视口变化时重新计算位置，并限制最大高度、在下方空间不足时向上翻转。
- 通过 `name` 对应的隐藏表单值保持 `FormData`；必填代理控件触发校验时阻止离屏焦点，改为聚焦可见触发器并显示无效状态。
- 控制台 surface 使用全局主题 token；Spark surface 使用现有演示页色彩。桌面触发器维持 38px 紧凑高度，手机触发器与选项行至少 44px。

- [x] **Step 1：** 编写 `Select.tsx` 的上述 props 与选项解析类型。
- [x] **Step 2：** 实现受控/非受控值、触发器状态、listbox 选择和焦点保持。
- [x] **Step 3：** 实现键盘移动、禁用跳过、首字母检索、Escape 和点击外关闭。
- [x] **Step 4：** 加入 portal 定位、视口翻转和滚动/resize 监听清理。
- [x] **Step 5：** 实现暗色、浅色、Spark、focus-visible、disabled、invalid 与移动端样式。
- [x] **Step 6：** 用当前项目筛选页检查静态渲染和 TypeScript 类型，再进入页面迁移。

### Task 2: 完成项目页并修正危险操作

**文件：** 修改 `web/app/(dashboard)/projects/page.tsx`、`ProjectFormDialog.tsx`、`FollowupDialog.tsx`、`ProjectsListContent.tsx`、`web/app/globals.css`、`web/components/ui/Select.tsx`、`web/components/ui/PageHeader.module.css`。

- [x] 将项目状态、负责人、年份、负责人字段、合同状态和跟进方式的 `<select>` 改为共享 `Select`；每个 `onChange` 接收字符串，例如：

```tsx
<Select value={url.status} onChange={(value) => setUrl({ status: value })} aria-label="按状态筛选">
  <option value="">全部状态</option>
  {statusOptions.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
</Select>
```

- [x] 保留原先 `setUrl`、表单 `set`、disabled option、搜索参数和筛选默认值。
- [x] 在共享 Select 根节点添加稳定的 `data-select-root="true"` 标记；PageHeader 按该标记给桌面筛选项分配与原生 select 相同的弹性宽度，并在手机断点保留两列宽度，避免每个控件独占一行。
- [x] 为 `.btn-ghost.danger-link:hover` 与 `:focus-visible` 设置 `border-color: var(--danger)`、`background: var(--danger-bg)` 和 `color: var(--danger)`；普通幽灵按钮继续使用品牌色状态。
- [x] 浏览器中检查桌面 1440px 页头筛选布局、移动两列筛选布局、桌面行操作与移动卡片/详情删除入口的一致危险态；不触发实际删除。

### Task 3: 迁移列表筛选

**文件：** 修改 `web/app/(dashboard)/contacts/page.tsx`、`reports/page.tsx`、`costs/page.tsx`、`opportunities/page.tsx`、`assets/page.tsx`、`assets/assets.css`。

- [x] 将部门、人员、成本状态、商机阶段、设备分类/状态/验收状态等所有筛选或登记下拉迁移到 `Select`。
- [x] 保持每个现有 `aria-label`、字符串值、URL 状态、分页重置逻辑、`name` 和 `required` 属性。
- [x] 资产录入表单使用 `surface="console"` 并保留批量设备中每个类别的必填校验。
- [x] 在 `web/app/(dashboard)/assets/assets.css` 中将 `.asset-filters select` 桌面与手机规则迁移到 `[data-select-root="true"]`，保留桌面宽度和手机两列筛选布局。
- [x] 在移动 390px 和桌面宽屏中检查筛选栏换行、浮层宽度和选项长文案。

### Task 4: 迁移业务抽屉和弹窗

**文件：** 修改 `web/app/(dashboard)/contacts/ContactDrawer.tsx`、`partners/PartnerDrawer.tsx`、`progress/TaskDialog.tsx`、`progress/MilestoneDialog.tsx`、`admin/UserDialog.tsx`、`costs/BudgetDialog.tsx`、`costs/ExpenseDialog.tsx`。

- [x] 将人员账号、部门、性别、直属主管、任职状态、合同类型、任务负责人/父任务/前置任务、里程碑负责人、管理员用户部门、预算科目和支出人员等 select 全部替换为共享组件。
- [x] 保留动态选项排序、空值文案、表单错误状态、禁用状态和原值 ID 字符串转换。
- [ ] 在每种 Dialog/Drawer 中打开长选项浮层，检查它不会被滚动容器裁切；键盘 Escape 关闭浮层后焦点仍在触发器，第二次 Escape 保持原 Dialog/Drawer 行为。

### Task 5: 迁移财务交互

**文件：** 修改 `web/app/(dashboard)/finance/page.tsx`、`finance/finance.module.css`、`finance/BookMembersDialog.tsx`、`finance/ArapStatementDialog.tsx`、`finance/ArapPanel.tsx`、`finance/ArapDialogs.tsx`、`finance/ProjectExpensePanel.tsx`。

- [x] 迁移账套、科目、模板、成员角色、对方科目、核销科目、辅助核算、会计期间、项目和审批状态选择。
- [x] 保持下拉选择后的日期、分页和辅助核算清理逻辑原样，例如：

```tsx
<Select value={periodId} onChange={(value) => {
  const next = openPeriods.find((item) => String(item.id) === value);
  setPeriodId(value);
  setDate(next && sourceDateInPeriod(expense, next) ? expense.exp_date ?? "" : "");
}}>
  <option value="">请选择开放期间</option>
  {openPeriods.map((item) => <option key={item.id} value={item.id}>{item.period}</option>)}
</Select>
```

- [x] 将移动端财务页 `<details>/<summary>` 改为按钮触发的 `role="menu"` 浮层；支持方向键、Home/End、Escape、Tab 焦点离开时关闭、外部点击关闭及焦点返回，不改菜单中按钮回调。
- [x] 菜单空间不足时翻到触发器上方，按视口高度限高并允许菜单内滚动；向上定位使用 `min(menu.scrollHeight, maxHeight)` 作为实际面板高度，使面板贴住触发器。滚动或视口变化时重新定位。使用 `var(--radius)` 保持直角控制台形状，并用 CSS 或 SVG 绘制箭头。
- [ ] 在一个 Dialog 内连续打开和选择科目，确认选择器 portal 仍处在 Modal 层级之上且焦点管理正常。

### Task 6: 迁移通用、移动和演示页组件

**文件：** 修改 `web/components/motion/MotionTabs.tsx`、`MotionTabs.module.css`、`web/components/ui/Pagination.tsx`、`web/components/spark/pages/BillingPage.tsx`、`PermissionPage.tsx`、`SparkPages.module.css`。

- [x] `MotionTabs` 手机选择共享 `Select`；桌面 tab、tabpanel、Framer Motion 过渡保持不变。
- [x] `Pagination` 每页条数控件使用 `Select` 并保留现有步进回调。
- [x] Spark 收银门店与演示成员角色使用 `surface="spark"`，其弹层沿用当前演示页的深底与青色状态。

### Task 7: 清理残留并完成人工验证

**文件：** `web/app/globals.css` 和本计划列出的所有迁移文件。

- [x] 清除 `globals.css` 中仅供原生 select 使用的箭头、appearance、焦点、disabled、表单字段和错误状态选择器；保留 input/date/month/datetime-local 的系统样式。
- [x] 用 `rg -n '<select\\b|<details\\b|<summary\\b' web --glob '*.tsx' --glob '!*.test.*'` 检查生产组件；只允许日期等既定保留控件，不得留下可见的原生选择菜单或财务 disclosure。
- [ ] 执行 `npx tsc --noEmit --project tsconfig.json` 检查 TypeScript 类型。
- [ ] 用现有开发服务器进行一次批量人工检查：桌面 1440×900、平板/窄桌面约 1024px、手机 390×844；深浅主题各检查项目筛选、项目表单、联系人抽屉、财务弹窗和移动账套菜单。
- [ ] 逐个检查鼠标、键盘、触控、焦点环、长文本、禁用选项、必填失败、菜单遮挡和 reduced-motion；浏览器无控制台报错、页面无横向溢出。
- [x] 按 Impeccable context 要求，对最终修改的 TSX/CSS 目标运行一次 `impeccable detect --json`，修复实际命中后仅再执行本计划允许的最终确认。
- [x] 检查最终 `git diff --check`、工作区状态和文件差异；按任务边界使用中文提交标题。

## 完成定义

全部 58 个原生下拉入口都使用共享自绘组件，移动财务操作不再使用浏览器 disclosure，项目删除 hover/focus 呈现红色危险边框；各页面原有值、必填、筛选与回调行为保持不变，桌面和移动主题检查完成。
