import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const page = readFileSync(
  join(process.cwd(), "app/(dashboard)/projects/[id]/page.tsx"),
  "utf8",
);

test("项目完整档案的合同附件接入在线预览", () => {
  const contractList = page.match(/\{contracts\.length === 0[\s\S]*?<\/section>/)?.[0];
  assert.ok(contractList, "合同 Tab 应包含合同附件列表");
  assert.match(contractList, /contracts\.map\(\(a\) =>/);
  assert.match(contractList, /canPreviewInline\(a\)\s*\?\s*"预览"\s*:\s*"查看"/);
  assert.match(contractList, /onClick=\{\(\) => setFilePreview\(a\)\}/);
  assert.match(page, /<AttachmentPreviewDialog[\s\S]*loadUrl=\{fetchPreviewUrl\}/);
});

test("附件预览弹层由公共组件统一提供", () => {
  const shared = join(process.cwd(), "components/ui/AttachmentPreviewDialog.tsx");
  assert.equal(existsSync(shared), true);
  for (const file of [
    "app/(dashboard)/projects/[id]/page.tsx",
    "app/(dashboard)/projects/ProjectFormDialog.tsx",
    "app/(dashboard)/partners/PartnerDrawer.tsx",
    "app/(dashboard)/contacts/ContactDrawer.tsx",
    "app/(dashboard)/costs/ExpenseVouchersDialog.tsx",
  ]) {
    assert.match(
      readFileSync(join(process.cwd(), file), "utf8"),
      /@\/components\/ui\/AttachmentPreviewDialog/,
      file,
    );
  }
  assert.equal(
    existsSync(join(process.cwd(), "app/(dashboard)/projects/[id]/AttachmentPreviewDialog.tsx")),
    false,
  );
});
