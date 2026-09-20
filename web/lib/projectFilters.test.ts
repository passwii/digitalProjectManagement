import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProjectListQuery, normalizeProjectOwnerName } from "./projectFilters";

describe("项目台账负责人查询", () => {
  it("把下拉选中的负责人姓名作为 owner 传给后端（不传 owner_id）", () => {
    const query = buildProjectListQuery({
      page: 2,
      size: 15,
      sort: "-code",
      keyword: "合同",
      status: "doing",
      owner: "张爱杰",
      code: "PJ-2026-",
    });

    assert.equal(
      query,
      "?page=2&size=15&sort=-code&keyword=%E5%90%88%E5%90%8C&status=doing" +
        "&owner=%E5%BC%A0%E7%88%B1%E6%9D%B0&code=PJ-2026-",
    );
    // 回归：只要出现 owner_id，按 id 筛就会把创建人名下的项目全捞出来（还是全部结果）
    assert.doesNotMatch(query, /owner_id/);
  });

  it("清除负责人时省略 owner，其他筛选仍保持", () => {
    assert.equal(
      buildProjectListQuery({ page: 1, size: 15, sort: "-code", owner: "", status: "filed" }),
      "?page=1&size=15&sort=-code&status=filed",
    );
  });

  it("只去掉姓名两侧空白，不改写内容（同名/含空格的历史值也能筛）", () => {
    assert.equal(normalizeProjectOwnerName("  张爱杰 "), "张爱杰");
    assert.equal(normalizeProjectOwnerName(undefined), "");
    assert.equal(normalizeProjectOwnerName(0), "0");
    assert.equal(
      buildProjectListQuery({ page: 1, size: 15, sort: "-code", owner: " 李智 " }),
      "?page=1&size=15&sort=-code&owner=%E6%9D%8E%E6%99%BA",
    );
  });
});
