# 样式化日期组件 DatePicker（feat/date-picker-component）

## 目标

用一套符合「交付控制台」设计语言的日期组件，替换项目里 30 处原生 `<input type="date">` / `<input type="month">`。

**本次只交付组件本身 + 测试 + 参考页**，30 处调用点的迁移按页面分批单独提交，降低回归面、便于 review。

## 勘察结论（决定了下面的设计）

| 结论 | 影响 |
| --- | --- |
| 样式方案是 **CSS Modules** + `app/globals.css` 的全局 token | 组件写 `X.tsx` + `X.module.css` 同目录并排，颜色只用 `var(--x)` |
| `--radius: 0px`，`--motion: 140ms ease-out`，等宽字体用于日期/编号/金额 | 几何与动效沿用现成 token，不新增 |
| 浅色主题只覆盖颜色、**不覆盖** `--radius` / `--motion` | 只写一套几何 + `var()`，深浅自动成立，**禁止写 `[data-theme]` 分支** |
| 最贴近的现有实现是 `components/ui/ProjectPicker.tsx`（触发器 + 绝对定位弹层 + 键盘导航 + ARIA） | 弹层行为逐条对标它：mousedown 外部点击、Esc、焦点归还、`z-index: 45` |
| `Field` 渲染的是 `<label>` | 触发器**必须**是 `<button type="button">`，否则点 label 不生效、a11y 树断裂 |
| 全站**零日期库**依赖（无 dayjs / date-fns） | 零新依赖，日期计算用原生 `Date` |
| 30 处调用点的 value 契约全部是 `YYYY-MM-DD` 字符串 | `onChange` 必须 emit 精确 `YYYY-MM-DD`，迁移才能近乎零改动 |
| 测试双 runner：`lib/*.test.ts` 走 node:test（**无 DOM lib**）；`lib/*.vitest.test.tsx` 走 vitest + jsdom | 纯日期逻辑抽到 `lib/dateCore.ts`，可脱离浏览器单测 |

## 风险：Esc 会穿透到 Modal（必须在本次解决）

`Modal.tsx:195` 的 Esc 监听是 `document.addEventListener("keydown", onKey, true)` —— **capture 阶段**。capture 的执行顺序是 document → … → target，而 React 18 把事件监听挂在 root container 上，所以：

1. Modal 的 capture handler **先**执行，调用 `e.stopPropagation()`；
2. 事件根本到不了 DatePicker 的 `onKeyDown`；
3. 结果：在 Dialog 里按一次 Esc，整个弹窗关闭，日期弹层跟着被卸载。

`ProjectPicker` 同样有此问题（它在自己 handler 里 `stopPropagation()` 是无效的，因为 Modal 已经先截断了）。本次不能只照抄这个模式。

**解决方式**：`lib/nestedPopover.ts` 提供一个「嵌套弹层登记簿」。DatePicker 打开时登记、关闭时注销；`Modal` 的 Esc handler 开头检查 `hasOpenNestedPopover()`，有则**直接 return**，让 Esc 先关日期弹层。这是纯增量改动 —— 没有嵌套弹层时 Modal 行为完全不变。

## 交付内容

### 1. `web/lib/dateCore.ts`（纯逻辑，零 DOM 类型，可 node:test）

日期计算层，对齐 `lib/modalFocus.ts` 的风格（只用结构化接口 + 纯函数，不碰 DOM / React）。

- `todayISO()` —— **本地时区**口径。现有 `labels.ts:196` 的 `todayISO()` 用 `toISOString()`（UTC），在 UTC+8 的 00:00–08:00 会给出「昨天」；`ArapDialogs.tsx:21`、`ArapStatementDialog.tsx:9`、`ArapPanel.tsx:47` 三处已各自重复实现本地版本。本组件的「今天」必须用本地口径，并顺手把这三处收敛过来。
- `toISO(y, m, d)` / `parseISO(s)` / `isSameDay` / `compareISO`
- `buildMonthMatrix(year, month)` —— 返回 6×7 的日历格子（含上下月补白）
- `isDayDisabled(iso, { min, max })` —— min/max 边界
- `startOfWeek / startOfMonth / endOfMonth`（周一为一周起点）
- `formatMonthTitle(y, m)` → `2026 年 9 月`
- `formatAriaDate(iso)` → `2026年9月29日 星期二`（供 `aria-label`，全中文）
- `QUICK_PRESETS` → 今天 / 本周 / 本月 / 清除
- `monthKey(iso)` → `YYYY-MM`（MonthPicker 用）

**校验要点**：全部用 `new Date(y, m, d)` 本地构造，**不碰 `toISOString()`**，避免 UTC 偏移导致差一天。

### 2. `web/lib/nestedPopover.ts`

`registerNestedPopover()` / `hasOpenNestedPopover()`，带引用计数，防重复登记。配套 `Modal.tsx` 的两行增量改动。

### 3. `web/components/ui/DatePicker.tsx` + `.module.css`

单个文件导出三个组件（对齐 `Modal.tsx` 的 named exports 风格），共用一份内部 `CalendarGrid`：

- **`DatePicker`** —— 单选，`YYYY-MM-DD`
- **`DateRangePicker`** —— 区间，两端 + 中间填充
- **`MonthPicker`** —— 月粒度，`YYYY-MM`（服务 `reports/page.tsx:170`）

props（对齐 ProjectPicker 的签名范式，默认值用中文字面量，全站无 i18n 框架）：

```ts
value: string; onChange: (v: string) => void;
min?: string; max?: string;
placeholder?: string; ariaLabel?: string;
disabled?: boolean; invalid?: boolean; name?: string; className?: string;
size?: "field" | "toolbar";   // 表单内 38px / 工具栏内 32px
quick?: boolean;              // 底部快捷选择条
```

行为要求：

- 触发器 `<button type="button">`，带 `aria-haspopup="dialog"` / `aria-expanded` / `aria-label` / `aria-invalid`
- 弹层 `position: absolute; z-index: 45; top: calc(100% + 4px)`，`--card` 底 + `1px var(--line)` + `--shadow-float`
- mousedown 外部关闭；Esc 关闭并归还焦点；`prefers-reduced-motion` 下降级
- **月历用 `role="grid"` + roving tabindex**，只让当前焦点格 `tabIndex=0`。
  原因：`Modal` 的 Tab trap 会把弹层内所有可聚焦元素纳入循环，若 42 个日期格都是 `<button>`，用户在 Dialog 里按 Tab 要穿过 42 格。
- **禁用态不能只靠颜色**（`light-mode-theme-design.md` L26 明文要求）：越界日期用 `aria-disabled` + 降低不透明度；选中态用 `font-weight: 600`；今天加边框。
- 移动端 `@media (max-width: 640px)` 弹层 `left:0; right:0; width:auto` 不横向溢出；快捷按钮 `min-height: var(--m-tap)`（44px）
- `invalid` 时自行实现 `border-color: var(--danger)` + `box-shadow: 0 0 0 3px rgba(181,60,53,.12)` —— 这条现有规则只作用于原生元素，`<button>` 触发器吃不到（`BudgetDialog.tsx:122` 等 4 处依赖它）

### 4. 测试

- `web/lib/dateCore.test.ts` —— node:test，锁死 UTC 偏移、本周边界、min/max、闰年 2 月、跨月补白
- `web/lib/datePicker.dom.vitest.test.tsx` —— vitest + jsdom，验证开合、选值、快捷键、min/max 置灰、Esc 归还焦点、Range 两段
- 跑 `npm test` 确认新增测试**真的出现在输出里**（`vitest.config.ts:24-28` 注释警告过 include 曾漏掉 `.tsx`）

### 5. 参考页

`app/(dashboard)/settings/date-picker/page.tsx`（或就近的开发参考页）并排展示三个组件 × 深浅主题 × 移动宽度，作为视觉验收与后续迁移的样板。

## 不在本次范围

- 30 处调用点的迁移（分批单独 PR）
- `globals.css:290-317` 那 12 条 `input[type="date"]` 样式的清理（全站迁完再做）
- 时区相关的 datetime-local（当前 0 处使用）

## 验收

1. `npm test` 全绿，且新增用例出现在输出中
2. `npm run build` 通过（TS 严格模式无错）
3. 参考页在深/浅主题下与原生输入框并排对比无视觉割裂
4. 在 `Dialog`（如 TaskDialog）里：Esc 只关日期弹层、Tab 不会穿过 42 个日期格
5. 390px 宽度下弹层不横向溢出、快捷按钮 ≥44px
