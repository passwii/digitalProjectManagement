import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("项目台账合同字段", () => {
  it("不再暴露前向合同和后向合同字段", () => {
    const paths = [
      "lib/api.ts",
      "lib/labels.ts",
      "app/(dashboard)/projects/ProjectFormDialog.tsx",
      "app/(dashboard)/projects/page.tsx",
      "app/(dashboard)/projects/[id]/page.tsx",
    ];
    for (const path of paths) {
      const text = source(path);
      assert.doesNotMatch(text, /forward_contract|backward_contract|前向合同|后向合同/);
    }
  });
});
