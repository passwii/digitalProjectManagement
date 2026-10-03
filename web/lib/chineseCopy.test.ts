import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("生产端中文界面文案", () => {
  it("登录页仅保留无标点宣传语，不展示指定的辅助文案", () => {
    const login = source("app/login/page.tsx");
    assert.match(login, /复杂有章\s*<span>交付有信<\/span>/);
    assert.doesNotMatch(login, /复杂有章，|交付有信。/);

    for (const removedCopy of [
      "项目协同 · 交付管理",
      "节点 07",
      "数字化项目运营",
      "把台账、进度、成本与审批，收束进同一条可追溯的工作链路",
      "认证入口 / 01",
      "本地节点 / 就绪",
      "数科云办公 // 项目运营",
      "©2026",
      "链路图 / 项目交付",
    ]) {
      assert.doesNotMatch(login, new RegExp(removedCopy));
    }
  });

  it("项目状态码在管理页以中文状态展示", () => {
    const labels = source("lib/labels.ts");
    assert.match(labels, /doing: "进行中"/);
    assert.match(labels, /archived: "已归档"/);
  });

  it("审计日志使用集中中文格式化，不直接展示原始编码", () => {
    const admin = source("app/(dashboard)/admin/page.tsx");
    assert.match(admin, /auditActionLabel/);
    assert.match(admin, /auditResourceDisplay/);
    assert.match(admin, /auditDetailLabel/);
    assert.doesNotMatch(admin, /<td className="mono tiny">\{l\.action\}<\/td>/);
    assert.doesNotMatch(admin, /title=\{l\.detail\}/);
  });

  it("工作台与财务页移除重复介绍，保留工作态势标题和会计规则", () => {
    const dashboard = source("app/(dashboard)/dashboard/page.tsx");
    const finance = source("app/(dashboard)/finance/page.tsx");
    const projectExpenses = source("app/(dashboard)/finance/ProjectExpensePanel.tsx");

    assert.doesNotMatch(dashboard, /把项目状态、介入事项与资金脉冲收束在同一张工作面上/);
    assert.match(dashboard, /当前工作态势/);
    assert.doesNotMatch(finance, /项目成本与财务账独立；已审批支出可在/);
    assert.doesNotMatch(finance, /凭证流水，草稿、待审核和已过账状态由后端控制/);
    assert.doesNotMatch(finance, /凭证审核、过账和账簿取数由后端状态机控制/);
    assert.match(finance, /新增资产当月不折旧，次月开始计提/);
    assert.match(finance, /结账前检查未审核凭证、断号、试算平衡和报表恒等式/);
    assert.doesNotMatch(projectExpenses, /选择已审批项目支出，逐笔生成当前账套的草稿凭证/);
  });

  it("资产页和更新页删除标题复述及宣传式导语", () => {
    const assets = source("app/(dashboard)/assets/page.tsx");
    const changelog = source("app/(dashboard)/changelog/page.tsx");

    for (const redundantCopy of [
      "按当前台账状态汇总",
      "当前台账中的设备分类",
      "按名称查找批次，查看设备数量、来源、验收情况和设备明细",
      "仅展示超过归还日期的设备",
      "按当前设备状态统计",
      "入库与出库记录按月份汇总",
      "选择使用人查看其设备台账",
      "批次来源及验收信息",
      "记录入库、领用、借用、归还和状态变化",
    ]) {
      assert.doesNotMatch(assets, new RegExp(redundantCopy));
    }
    assert.match(assets, /永久删除会连带清除该资产的设备流水，无法恢复/);
    assert.match(changelog, /<h1>功能更新<\/h1>/);
    assert.doesNotMatch(changelog, /记录每一次重要能力的上线与迭代/);
    assert.doesNotMatch(changelog, /从项目管理基本盘，到财务与移动协同，持续推进/);
  });

  it("项目与通讯录页面删除字段复述，保留附件限制和关键关联说明", () => {
    const project = source("app/(dashboard)/projects/[id]/page.tsx");
    const contacts = source("app/(dashboard)/contacts/ContactDrawer.tsx");

    assert.doesNotMatch(project, /现场照片与截图，点击缩略图放大查看/);
    assert.doesNotMatch(project, /项目背景、目标、会议结论与下一步安排/);
    assert.doesNotMatch(project, /支持 PDF \/ Word \/ Excel，单个文件不超过/);
    assert.match(project, /单个文件不超过 \{MAX_ATTACHMENT_SIZE_LABEL\}/);
    assert.doesNotMatch(contacts, /记录用工关系、直属上级和合同有效期/);
    assert.doesNotMatch(contacts, /最高学历、院校与专业信息/);
    assert.doesNotMatch(contacts, /用于紧急情况下的联系信息/);
    assert.match(contacts, /关联账号后，姓名和部门会同步到该账号/);
  });
});
