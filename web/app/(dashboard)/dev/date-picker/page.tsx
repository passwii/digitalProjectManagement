"use client";

/**
 * 日期组件参考页（视觉验收 + 迁移样板）。
 *
 * 不挂在主导航里（`BASE_HREFS` 没这一项），只能直接访问 `/dev/date-picker`，
 * 免得把一个开发用的样板页混进用户的日常导航。
 *
 * 用途：迁移 30 处原生 `<input type="date">` 时来这里对一眼，
 * 确认新组件在表单内、工具栏内、错误态、禁用态、窄屏下都和既有页面一致。
 */
import { useState } from "react";
import { DatePicker, DateRangePicker, MonthPicker } from "@/components/ui/DatePicker";
import Field from "@/components/ui/Field";
import s from "./date-picker.module.css";

function Row({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className={s.row}>
      <div className={s.rowHead}>
        <h2>{title}</h2>
        {note ? <p>{note}</p> : null}
      </div>
      <div className={s.rowBody}>{children}</div>
    </section>
  );
}

export default function DatePickerReferencePage() {
  const [single, setSingle] = useState("2026-09-29");
  const [empty, setEmpty] = useState("");
  const [bounded, setBounded] = useState("");
  const [invalid, setInvalid] = useState("2026-09-01");
  const [range, setRange] = useState<{ from?: string | null; to?: string | null }>({ from: "", to: "" });
  const [month, setMonth] = useState("2026-09");

  return (
    <div className={s.page}>
      <header className={s.pageHead}>
        <h1>日期组件</h1>
        <p className={s.lede}>
          替代原生 <code className="mono">input[type=date]</code> 的样式化组件。
          值契约与原生一致：单选产出 <code className="mono">YYYY-MM-DD</code>，月份产出{" "}
          <code className="mono">YYYY-MM</code>，因此迁移时只需换标签、不动后端载荷。
        </p>
      </header>

      <div className={s.compare}>
        <div className={s.compareCol}>
          <span className={s.compareTag}>原生</span>
          <input type="date" value={single} onChange={(e) => setSingle(e.target.value)} />
        </div>
        <div className={s.compareCol}>
          <span className={`${s.compareTag} ${s.compareTagNew}`}>新组件</span>
          <DatePicker value={single} onChange={setSingle} />
        </div>
      </div>

      <Row title="表单内（38px）" note="配合 Field 使用，最常见的宿主。">
        <div className={s.formGrid}>
          <Field label="单选日期">
            <DatePicker value={single} onChange={setSingle} />
          </Field>
          <Field label="未选择">
            <DatePicker value={empty} onChange={setEmpty} />
          </Field>
          <Field label="区间选择" hint="分两次点击定起止">
            <DateRangePicker value={range} onChange={setRange} />
          </Field>
          <Field label="按月选择" hint="值契约 YYYY-MM">
            <MonthPicker value={month} onChange={setMonth} />
          </Field>
        </div>
      </Row>

      <Row title="错误与禁用" note="错误边框与 Field 的错误文案配套；禁用沿用次级表面。">
        <div className={s.formGrid}>
          <Field label="预算期间-结束" error={invalid ? "须晚于预算开始日期" : undefined}>
            <DatePicker value={invalid} onChange={setInvalid} invalid={!!invalid} />
          </Field>
          <Field label="已停用的合同">
            <DatePicker value="2026-01-01" onChange={() => {}} disabled />
          </Field>
        </div>
      </Row>

      <Row title="min / max 值域" note="界外日期置灰且不可选；整月都不可选时翻页按钮同时禁用。">
        <div className={s.formGrid}>
          <Field label="交易日期" hint="须落在项目计划起止内">
            <DatePicker
              value={bounded}
              onChange={setBounded}
              min="2026-09-10"
              max="2026-09-20"
            />
          </Field>
          <Field label="结算月份" hint="不早于 2026-03">
            <MonthPicker value={month} onChange={setMonth} min="2026-03" />
          </Field>
        </div>
      </Row>

      <Row title="工具栏内（32px）" note="报表筛选区宿主，高度与 .toolbar-field 对齐。">
        <div className={`${s.toolbar} toolbar-field`}>
          <span>开始日期</span>
          <DatePicker value={range.from ?? ""} onChange={(v) => setRange((r) => ({ ...r, from: v }))} size="toolbar" quick={false} />
          <span>结束日期</span>
          <DatePicker value={range.to ?? ""} onChange={(v) => setRange((r) => ({ ...r, to: v }))} size="toolbar" quick={false} />
        </div>
      </Row>

      <Row title="键盘" note="方向键移动、Enter 选中、Esc 关闭并归还焦点；整张月历只占一个 Tab 停留点。">
        <div className={s.formGrid}>
          <Field label="试试按方向键">
            <DatePicker value={single} onChange={setSingle} />
          </Field>
        </div>
      </Row>
    </div>
  );
}
