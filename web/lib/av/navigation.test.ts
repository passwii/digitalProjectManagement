import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  AV_HIDDEN_ROUTES,
  AV_PAGES,
  AV_WINDOW_TARGET,
  avDetailHref,
  avPageForSection,
  isAvHiddenRoute,
  isAvRoute,
  isAvSection,
} from "./navigation";

describe("AV 导航契约", () => {
  it("导航恰好 6 个页面（不是 sample 的 9 个）", () => {
    assert.equal(AV_PAGES.length, 6);
    assert.deepEqual(
      AV_PAGES.map((page) => page.slug),
      ["overview", "monitor", "alarm", "event", "device", "capability"],
    );
  });

  it("href 唯一、全部落在 /av 下，且 slug 与 href 尾段一致", () => {
    const hrefs = new Set(AV_PAGES.map((page) => page.href));
    assert.equal(hrefs.size, AV_PAGES.length);
    for (const page of AV_PAGES) {
      assert.ok(page.href.startsWith("/av/"), `${page.href} 不在 /av 下`);
      assert.equal(page.href, `/av/${page.slug}`);
      assert.ok(page.label.length > 0);
      assert.ok(page.group.length > 0);
    }
  });

  it("辅助页不进主导航，但允许直达", () => {
    for (const hidden of AV_HIDDEN_ROUTES) {
      assert.ok(!isAvSection(hidden.slug), `${hidden.slug} 不应出现在导航里`);
      assert.ok(isAvHiddenRoute(hidden.slug));
      assert.ok(isAvRoute(hidden.slug));
    }
    assert.deepEqual(
      AV_HIDDEN_ROUTES.map((route) => route.slug),
      ["__stress", "audio"],
    );
  });

  it("未知 section 一律拒绝", () => {
    assert.equal(isAvRoute("nope"), false);
    assert.equal(isAvSection("alarm"), true);
    assert.equal(avPageForSection("alarm")?.label, "告警中心");
    assert.equal(avPageForSection("nope"), undefined);
  });

  it("深链接路径对 id 做 URL 编码（告警 / 事件 id 直接可用）", () => {
    assert.equal(avDetailHref("alarm", "AL-00042"), "/av/alarm/AL-00042");
    assert.equal(avDetailHref("event", "EV 1"), "/av/event/EV%201");
  });

  it("两个演示入口使用不同浏览上下文", () => {
    assert.equal(AV_WINDOW_TARGET, "av-platform");
  });
});

describe("入口接线（源码契约）", () => {
  const middleware = readFileSync(resolve(process.cwd(), "middleware.ts"), "utf8");
  const layout = readFileSync(resolve(process.cwd(), "app/(dashboard)/layout.tsx"), "utf8");

  it("middleware 把 /av 放进 PUBLIC_PATHS，并重定向到 /av/overview", () => {
    const publicBlock = middleware.slice(middleware.indexOf("const PUBLIC_PATHS"), middleware.indexOf("];"));
    assert.match(publicBlock, /"\/av"/);
    assert.match(middleware, /pathname === "\/av"[\s\S]*?url\.pathname = "\/av\/overview"/);
    // /spark 的既有行为一字未动
    assert.match(middleware, /pathname === "\/spark"[\s\S]*?url\.pathname = "\/spark\/dashboard"/);
  });

  it("左侧 Spark 分组下同时有 NebulaCloud 与智能音视频平台，两条各自独立 target", () => {
    assert.match(layout, /"\/av": "智能音视频平台"/);
    assert.match(layout, /out\.push\(\{ href: "\/spark"/);
    assert.match(layout, /out\.push\(\{ href: "\/av"/);
    assert.match(layout, /AV_WINDOW_TARGET/);
    assert.match(layout, /SPARK_WINDOW_TARGET/);
  });
});
