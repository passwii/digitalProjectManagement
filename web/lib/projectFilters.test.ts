import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProjectListQuery, INVALID_OWNER_ID, normalizeProjectOwnerId } from "./projectFilters";

describe("项目台账负责人查询", () => {
  it("将下拉选择的负责人 ID 作为 owner_id 传递", () => {
    const query = buildProjectListQuery({
      page: 2,
      size: 15,
      sort: "-id",
      keyword: "合同",
      status: "doing",
      owner: "42",
      code: "PJ-2026-",
    });

    assert.equal(
      query,
      "?page=2&size=15&sort=-id&keyword=%E5%90%88%E5%90%8C&status=doing&owner_id=42&code=PJ-2026-",
    );
  });

  it("清除负责人时省略 owner_id，其他筛选仍保持", () => {
    assert.equal(
      buildProjectListQuery({ page: 1, size: 15, sort: "-id", owner: "", status: "filed" }),
      "?page=1&size=15&sort=-id&status=filed",
    );
  });

  it("非法 URL 负责人值映射为不可能命中的 ID，不退化为全量", () => {
    assert.equal(normalizeProjectOwnerId("abc"), INVALID_OWNER_ID);
    assert.equal(normalizeProjectOwnerId("0"), INVALID_OWNER_ID);
    assert.equal(normalizeProjectOwnerId("12.5"), INVALID_OWNER_ID);
    assert.equal(
      buildProjectListQuery({ page: 1, size: 15, sort: "-id", owner: "abc" }),
      "?page=1&size=15&sort=-id&owner_id=-1",
    );
  });

  it("已不存在但格式合法的负责人 ID 仍保持精确过滤", () => {
    assert.equal(normalizeProjectOwnerId("999999"), 999999);
    assert.equal(
      buildProjectListQuery({ page: 1, size: 15, sort: "-id", owner: "999999" }),
      "?page=1&size=15&sort=-id&owner_id=999999",
    );
  });
});
