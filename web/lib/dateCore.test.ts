import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addMonths,
  buildMonthMatrix,
  compareISO,
  endOfMonth,
  endOfWeek,
  formatAriaDate,
  formatDisplayDate,
  formatDisplayMonth,
  isCompleteRange,
  isInRange,
  isSameDay,
  isWithinBounds,
  monthKey,
  parseISO,
  QUICK_PRESETS,
  shiftDays,
  startOfMonth,
  startOfWeek,
  toISO,
  todayISO,
  weekdayName,
} from "./dateCore";

describe("日期解析与格式化", () => {
  it("把三段拼成 YYYY-MM-DD，并对月/日补零", () => {
    assert.equal(toISO(2026, 8, 5), "2026-09-05");
    assert.equal(toISO(2026, 11, 31), "2026-12-31");
  });

  it("容忍后端带回的时间部分", () => {
    assert.deepEqual(parseISO("2026-09-29T10:00:00"), { year: 2026, month: 8, day: 29 });
  });

  it("把形状不合法和实际不存在的日期都判为无效", () => {
    // 2026-02-30 形状合法但 2 月没有 30 号；new Date 会静默滚到 3 月 2 日，
    // 不校验就会显示成一个用户根本没选过的日期。
    assert.equal(parseISO("2026-02-30"), null);
    assert.equal(parseISO("2026-13-01"), null);
    assert.equal(parseISO("2026-00-10"), null);
    assert.equal(parseISO("2026-04-31"), null);
    assert.equal(parseISO(""), null);
    assert.equal(parseISO(null), null);
    assert.equal(parseISO("不是日期"), null);
  });

  it("接受闰年 2 月 29 日", () => {
    assert.deepEqual(parseISO("2028-02-29"), { year: 2028, month: 1, day: 29 });
  });

  it("展示文案与无障碍文案都是中文", () => {
    assert.equal(formatDisplayDate("2026-09-29"), "2026 年 9 月 29 日");
    assert.equal(formatDisplayDate("", "选择日期"), "选择日期");
    assert.equal(formatDisplayMonth("2026-09"), "2026 年 9 月");
    assert.equal(formatAriaDate("2026-09-29"), "2026年9月29日 星期二");
  });

  it("weekdayName 以周一为一周起点", () => {
    assert.equal(weekdayName("2026-09-28"), "星期一");
    assert.equal(weekdayName("2026-10-04"), "星期日");
  });

  it("monthKey 只认 YYYY-MM 并校验月份范围", () => {
    assert.equal(monthKey("2026-09-29"), "2026-09");
    assert.equal(monthKey("2026-13"), "");
    assert.equal(monthKey(""), "");
  });
});

describe("日期比较", () => {
  it("按字典序比较与时间序一致", () => {
    assert.equal(compareISO("2026-09-29", "2026-09-30"), -1);
    assert.equal(compareISO("2026-10-01", "2026-09-30"), 1);
    assert.equal(compareISO("2026-09-29", "2026-09-29"), 0);
  });

  it("非法值排到最前，不卡住范围比较", () => {
    assert.equal(compareISO(undefined, "2026-09-29"), -1);
    assert.equal(compareISO("2026-09-29", ""), 1);
  });

  it("isSameDay 忽略尾部时间部分", () => {
    assert.equal(isSameDay("2026-09-29", "2026-09-29T23:59:00"), true);
    assert.equal(isSameDay("2026-09-29", "2026-09-30"), false);
  });

  it("min/max 是闭区间，undefined 表示不限", () => {
    assert.equal(isWithinBounds("2026-09-15", "2026-09-01", "2026-09-30"), true);
    assert.equal(isWithinBounds("2026-09-01", "2026-09-01", "2026-09-30"), true);
    assert.equal(isWithinBounds("2026-09-30", "2026-09-01", "2026-09-30"), true);
    assert.equal(isWithinBounds("2026-08-31", "2026-09-01", "2026-09-30"), false);
    assert.equal(isWithinBounds("2026-10-01", "2026-09-01", "2026-09-30"), false);
    assert.equal(isWithinBounds("1999-01-01", undefined, undefined), true);
    assert.equal(isWithinBounds("1999-01-01", "2026-01-01", undefined), false);
  });
});

describe("月历矩阵", () => {
  it("固定 6 行 × 7 列，切换月份时弹层不跳高", () => {
    // 2026 年 2 月只有 28 天，若按需行数渲染，与 3 月(31 天)之间会看到高度突变
    assert.equal(buildMonthMatrix(2026, 1).length, 42);
    assert.equal(buildMonthMatrix(2026, 2).length, 42);
  });

  it("首列是周一：2026-09-01 是周二，前面补 1 天", () => {
    const cells = buildMonthMatrix(2026, 8);
    assert.equal(cells[0].iso, "2026-08-31");
    assert.equal(cells[0].inMonth, false);
    assert.equal(cells[1].iso, "2026-09-01");
    assert.equal(cells[1].inMonth, true);
  });

  it("周日落在最后一列", () => {
    const cells = buildMonthMatrix(2026, 8);
    // 2026-09-01 是周二，索引 1；周日 = 索引 6 => 2026-09-06
    assert.equal(cells[6].iso, "2026-09-06");
  });

  it("跨年月份的补白会正确滚年", () => {
    const january = buildMonthMatrix(2026, 0);
    // 2026-01-01 是周四，周四 → 索引 3，前面补 3 格
    assert.equal(january[0].iso, "2025-12-29");
    const december = buildMonthMatrix(2026, 11);
    // 2026-12-01 是周二 → 索引 1；31 天占满索引 1..31，剩 10 格补到 2027 年 1 月
    assert.equal(december[41].iso, "2027-01-10");
  });

  it("闰年二月有 29 号", () => {
    const cells = buildMonthMatrix(2028, 1);
    assert.ok(cells.some((cell) => cell.iso === "2028-02-29" && cell.inMonth));
  });
});

describe("区间边界", () => {
  it("本周以周一为起点", () => {
    assert.equal(startOfWeek("2026-09-30"), "2026-09-28");
    assert.equal(startOfWeek("2026-09-28"), "2026-09-28");
    assert.equal(startOfWeek("2026-10-04"), "2026-09-28");
    assert.equal(endOfWeek("2026-09-30"), "2026-10-04");
  });

  it("周区间跨月跨年都正确", () => {
    assert.equal(startOfWeek("2026-10-01"), "2026-09-28");
    assert.equal(startOfWeek("2027-01-01"), "2026-12-28");
  });

  it("本月起止", () => {
    assert.equal(startOfMonth("2026-02-15"), "2026-02-01");
    assert.equal(endOfMonth("2026-02-15"), "2026-02-28");
    assert.equal(endOfMonth("2028-02-15"), "2028-02-29");
  });

  it("shiftDays 跨月跨年进位正确", () => {
    assert.equal(shiftDays("2026-09-30", 1), "2026-10-01");
    assert.equal(shiftDays("2026-01-01", -1), "2025-12-31");
    assert.equal(shiftDays("2026-03-01", -1), "2026-02-28");
    assert.equal(shiftDays("2028-03-01", -1), "2028-02-29");
  });

  it("addMonths 在月末收敛到目标月最后一天", () => {
    assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
    assert.equal(addMonths("2026-01-15", -1), "2025-12-15");
    assert.equal(addMonths("2026-06-15", 12), "2027-06-15");
  });
});

describe("区间完整性", () => {
  it("两端都在且不倒挂才算完整", () => {
    assert.equal(isCompleteRange({ from: "2026-09-01", to: "2026-09-30" }), true);
    assert.equal(isCompleteRange({ from: "2026-09-01", to: "" }), false);
    assert.equal(isCompleteRange({ from: "2026-09-30", to: "2026-09-01" }), false);
    assert.equal(isCompleteRange(null), false);
  });

  it("只定了一端时按已有的一端判断归属", () => {
    assert.equal(isInRange("2026-09-15", { from: "2026-09-01", to: null }), true);
    assert.equal(isInRange("2026-08-15", { from: "2026-09-01", to: null }), false);
    assert.equal(isInRange("2026-09-15", {}), false);
  });
});

describe("快捷选择", () => {
  const today = "2026-09-30"; // 周三
  const resolve = (kind: string) => QUICK_PRESETS.find((p) => p.kind === kind)?.resolve(today);

  it("今天就是当天", () => {
    assert.equal(resolve("today"), "2026-09-30");
  });

  it("本周落到周一", () => {
    assert.equal(resolve("week"), "2026-09-28");
  });

  it("本月落到 1 号", () => {
    assert.equal(resolve("month"), "2026-09-01");
  });

  it("清除产出 null", () => {
    assert.equal(resolve("clear"), null);
  });
});

describe("本地时区口径", () => {
  it("todayISO 按本地日期而非 UTC", () => {
    // 用 UTC+8 的「本地凌晨」构造：toISOString() 在这一刻会退回到前一天，
    // 而日期组件的「今天」必须是本地那一天。
    const local = new Date(2026, 8, 29, 0, 30, 0);
    assert.equal(todayISO(local), "2026-09-29");
    // 若实现退化成 UTC 口径，在 UTC+8 环境里这里就会得到 2026-09-28
    assert.equal(todayISO(local), "2026-09-29");
  });

  it("本地月末的最后一刻仍算当天", () => {
    const last = new Date(2026, 8, 30, 23, 59, 59);
    assert.equal(todayISO(last), "2026-09-30");
  });
});
