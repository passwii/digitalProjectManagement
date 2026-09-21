import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(process.cwd(), "app/(dashboard)/partners");
const list = readFileSync(join(root, "page.tsx"), "utf8");
const drawer = readFileSync(join(root, "PartnerDrawer.tsx"), "utf8");

test("友商列表只保留名称搜索", () => {
  assert.doesNotMatch(list, /partner_type|友商类型|人员数/);
  assert.match(list, /搜索友商名称/);
});

test("友商档案移除类型和人员区域", () => {
  assert.doesNotMatch(drawer, /partner_type|友商类型|人员信息|PartnerMember|membersApi/);
});

test("添加业绩旁使用合同分类上传附件", () => {
  assert.match(drawer, /合同附件/);
  assert.match(drawer, /partnersApi\.upload\(partner\.id,\s*["']contract["']/);
  assert.match(drawer, /useUploadQueue/);
});
