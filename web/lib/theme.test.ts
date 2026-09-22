import test from "node:test";
import assert from "node:assert/strict";
import { parseStoredTheme, resolveTheme } from "../components/theme/theme";

test("未设置或非法值默认深色", () => {
  assert.equal(parseStoredTheme(null), "dark");
  assert.equal(parseStoredTheme("solarized"), "dark");
});

test("三档主题解析保持确定性", () => {
  assert.equal(resolveTheme("light", false), "light");
  assert.equal(resolveTheme("dark", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("system", true), "dark");
});

test("合法存储值被保留", () => {
  assert.equal(parseStoredTheme("light"), "light");
  assert.equal(parseStoredTheme("dark"), "dark");
  assert.equal(parseStoredTheme("system"), "system");
});
