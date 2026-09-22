import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  auditActionLabel,
  auditDetailLabel,
  auditResourceDisplay,
  auditResourceLabel,
} from "./auditLogLabels";

describe("审计日志中文展示", () => {
  it("将明确动作和资源码转换为中文", () => {
    assert.equal(auditActionLabel("create_project", "projects"), "创建项目");
    assert.equal(auditActionLabel("create", "voucher"), "创建凭证");
    assert.equal(auditActionLabel("update", "accounting_period"), "更新会计期间");
    assert.equal(auditResourceLabel("projects"), "项目");
  });

  it("对未知动作和资源使用中文兜底", () => {
    assert.equal(auditActionLabel("future_action", "future_resource"), "其他操作");
    assert.equal(auditResourceLabel("future_resource"), "其他资源");
  });

  it("组合中文资源和资源编号", () => {
    assert.equal(auditResourceDisplay("projects", "123"), "项目 #123");
    assert.equal(auditResourceDisplay("projects", ""), "项目");
    assert.equal(auditResourceDisplay("future_resource", "7"), "其他资源 #7");
  });

  it("翻译结构化详情并保留动态值", () => {
    assert.equal(
      auditDetailLabel("update_followup", "followups", "project=12"),
      "项目：12",
    );
    assert.equal(
      auditDetailLabel("apply_arap", "arap_transactions", "voucher=12,amount=300"),
      "凭证：12；金额：300",
    );
    assert.equal(
      auditDetailLabel("project_status", "projects", "doing->done 客户已验收"),
      "原状态：进行中 → 新状态：已完成；客户已验收",
    );
    assert.equal(
      auditDetailLabel("toggle_demo_data", "sys_params", "demo_data_on=1"),
      "演示数据：已开启",
    );
  });

  it("保留中文详情、业务文件名并处理空详情", () => {
    assert.equal(auditDetailLabel("login", "auth", "登录成功"), "登录成功");
    assert.equal(auditDetailLabel("upload_attachment", "attachments", "报告.pdf"), "报告.pdf");
    assert.equal(auditDetailLabel("future_action", "future_resource", ""), "操作详情已记录");
  });
});
