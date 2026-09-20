import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHANGELOG_VERSIONS } from "./changelog";

describe("changelog data", () => {
  it("contains V2 before V1 and each version has dated updates", () => {
    assert.deepEqual(CHANGELOG_VERSIONS.map((version) => version.id), ["v2", "v1"]);

    for (const version of CHANGELOG_VERSIONS) {
      assert.ok(version.title.length > 0);
      assert.ok(version.days.length > 0);
      assert.ok(version.days.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date)));
      assert.ok(version.days.every((day, index) => index === 0 || day.date <= version.days[index - 1].date));
      assert.ok(version.days.every((day) => day.entries.length > 0));
    }
  });
});
