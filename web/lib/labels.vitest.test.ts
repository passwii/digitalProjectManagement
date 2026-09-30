import { describe, expect, it } from "vitest";

import {
  contractStatusLabel,
  projectChangeFieldLabel,
  projectChangeValueLabel,
  projectStatusLabel,
} from "./labels";

describe("项目状态展示映射", () => {
  it("常见项目状态在所有变更值展示位置使用中文", () => {
    expect(projectStatusLabel("draft")).toBe("草稿");
    expect(projectStatusLabel("pending")).toBe("待立项审批");
    expect(projectStatusLabel("doing")).toBe("进行中");
    expect(projectStatusLabel("archived")).toBe("已归档");
    expect(projectChangeValueLabel("status", "cancelled")).toBe("已取消");
  });

  it("兼容历史合同状态英文值，且不改变原始提交值", () => {
    expect(contractStatusLabel("signed")).toBe("已签订");
    expect(contractStatusLabel("unsigned")).toBe("未签订");
    expect(projectChangeValueLabel("contract_status", "contracted")).toBe("已签订");
    expect(projectChangeValueLabel("contract_status", "未签订")).toBe("未签订");
  });

  it("空值使用稳定中文兜底，未知值保留原始值便于追溯", () => {
    expect(projectChangeValueLabel("status", null)).toBe("空");
    expect(projectChangeValueLabel("status", "")).toBe("空");
    expect(projectChangeValueLabel("status", "legacy_status")).toBe("legacy_status");
    expect(projectStatusLabel(undefined)).toBe("-");
    expect(projectChangeFieldLabel(null)).toBe("未知字段");
    expect(projectChangeFieldLabel("future_field")).toBe("future_field");
  });

  it("变更字段名也统一使用中文，覆盖历史成员字段和值字段", () => {
    expect(projectChangeFieldLabel("status")).toBe("项目状态");
    expect(projectChangeFieldLabel("contract_status")).toBe("合同状态");
    expect(projectChangeFieldLabel("members")).toBe("项目成员");
    expect(projectChangeFieldLabel("progress_snapshot")).toBe("进度快照");
  });

  it("成本 / 应收 / 回款这类事件型变更字段也有中文名", () => {
    expect(projectChangeFieldLabel("expense")).toBe("成本");
    expect(projectChangeFieldLabel("receivable")).toBe("应收");
    expect(projectChangeFieldLabel("receivable_payment")).toBe("回款");
  });
});
