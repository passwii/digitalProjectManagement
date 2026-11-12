import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHANGELOG_CURRENT_VERSION,
  CHANGELOG_VERSIONS,
  latestChangelogVersion,
  type ChangelogVersion,
} from "./changelog";

describe("changelog data", () => {
  it("lists V3 before V2 before V1", () => {
    assert.deepEqual(CHANGELOG_VERSIONS.map((version) => version.id), ["v3", "v2", "v1"]);
    assert.deepEqual(CHANGELOG_VERSIONS.map((version) => version.label), ["V3", "V2", "V1"]);
  });

  it("keeps every version dated, newest-first and non-empty", () => {
    for (const version of CHANGELOG_VERSIONS) {
      assert.ok(version.title.length > 0);
      assert.ok(version.summary.length > 0);
      assert.ok(version.days.length > 0);
      assert.ok(version.days.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date)));
      assert.ok(version.days.every((day, index) => index === 0 || day.date <= version.days[index - 1].date));
      assert.ok(version.days.every((day) => day.entries.length > 0));
      for (const day of version.days) {
        for (const entry of day.entries) {
          assert.ok(entry.title.length > 0);
          assert.ok(entry.description.length > 0);
        }
      }
    }
  });

  it("marks the newest version as current instead of hardcoding V2", () => {
    assert.equal(CHANGELOG_CURRENT_VERSION.id, "v3");
    assert.equal(CHANGELOG_CURRENT_VERSION.label, "V3");
    assert.equal(CHANGELOG_CURRENT_VERSION.label, CHANGELOG_VERSIONS[0].label);

    // 当前版本必须跟着数组首位走：换一份构造数据，标记也要跟着换。
    const synthetic: ChangelogVersion[] = [
      { id: "v2", label: "V9", title: "构造版本", summary: "用于验证动态取最新版本", days: [] },
      ...CHANGELOG_VERSIONS,
    ];
    assert.equal(latestChangelogVersion(synthetic).label, "V9");
    assert.throws(() => latestChangelogVersion([]), /不能为空/);
  });

  it("adds the Go 架构 V3 with the 2026-11 architecture updates", () => {
    const v3 = CHANGELOG_VERSIONS[0];
    assert.equal(v3.id, "v3");
    assert.equal(v3.title, "Go 架构");
    assert.ok(v3.days.every((day) => day.date.startsWith("2026-11")));

    const kinds = new Set(v3.days.flatMap((day) => day.entries.map((entry) => entry.kind)));
    assert.ok(kinds.has("架构"));

    const text = JSON.stringify(v3);
    for (const token of ["Go", "Goose", "GHCR", "Python", "PWA"]) {
      assert.ok(text.includes(token), `V3 should mention ${token}`);
    }
  });
});
