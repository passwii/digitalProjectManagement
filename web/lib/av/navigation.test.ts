import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  AV_BASE_PATH,
  AV_HIDDEN_ROUTES,
  AV_PAGES,
  AV_WINDOW_TARGET,
  avDetailHref,
  avPageForSection,
  isAvHiddenRoute,
  isAvRoute,
  isAvSection,
} from "./navigation";

describe("Stream Monitor 导航契约", () => {
  it("导航恰好 6 个页面（不是 sample 的 9 个）", () => {
    assert.equal(AV_PAGES.length, 6);
    assert.deepEqual(
      AV_PAGES.map((page) => page.slug),
      ["overview", "monitor", "alarm", "event", "device", "capability"],
    );
  });

  it("站点公开路径是 /stream-monitor（BLF-1387 改名后的唯一前缀）", () => {
    assert.equal(AV_BASE_PATH, "/stream-monitor");
    // 旧前缀不得再出现在导航契约里 —— 旧路径只由 middleware 做兼容重定向
    assert.equal(AV_BASE_PATH.startsWith("/av"), false);
  });

  it("href 唯一、全部落在 /stream-monitor 下，且 slug 与 href 尾段一致", () => {
    const hrefs = new Set(AV_PAGES.map((page) => page.href));
    assert.equal(hrefs.size, AV_PAGES.length);
    for (const page of AV_PAGES) {
      assert.ok(page.href.startsWith("/stream-monitor/"), `${page.href} 不在 /stream-monitor 下`);
      assert.equal(page.href, `/stream-monitor/${page.slug}`);
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
    assert.equal(avDetailHref("alarm", "AL-00042"), "/stream-monitor/alarm/AL-00042");
    assert.equal(avDetailHref("event", "EV 1"), "/stream-monitor/event/EV%201");
  });

  it("两个演示入口使用不同浏览上下文", () => {
    assert.equal(AV_WINDOW_TARGET, "stream-monitor");
  });
});

describe("入口接线（源码契约）", () => {
  const middleware = readFileSync(resolve(process.cwd(), "middleware.ts"), "utf8");
  const layout = readFileSync(resolve(process.cwd(), "app/(dashboard)/layout.tsx"), "utf8");

  it("middleware 把 /stream-monitor 放进 PUBLIC_PATHS，并重定向到 /stream-monitor/overview", () => {
    const publicBlock = middleware.slice(middleware.indexOf("const PUBLIC_PATHS"), middleware.indexOf("];"));
    assert.match(publicBlock, /"\/stream-monitor"/);
    // 总览地址收敛到 SITE_HOME 常量（值是 /stream-monitor/overview）
    assert.match(middleware, /const SITE_HOME = "\/stream-monitor\/overview"/);
    assert.match(
      middleware,
      /pathname === "\/stream-monitor"[\s\S]*?url\.pathname = SITE_HOME/,
    );
    // /spark 的既有行为一字未动
    assert.match(middleware, /pathname === "\/spark"[\s\S]*?url\.pathname = "\/spark\/dashboard"/);
  });

  it("旧路径 /av 走 308 兼容重定向，不留断链", () => {
    assert.match(middleware, /const LEGACY_AV_PREFIX = "\/av"/);
    assert.match(middleware, /NextResponse\.redirect\(url, 308\)/);
  });

  it("左侧 Spark 分组下同时有云电竞管理平台与 Stream Monitor，两条各自独立 target", () => {
    assert.match(layout, /"\/stream-monitor": "Stream Monitor"/);
    assert.match(layout, /out\.push\(\{ href: "\/spark"/);
    assert.match(layout, /out\.push\(\{ href: "\/stream-monitor"/);
    assert.match(layout, /AV_WINDOW_TARGET/);
    assert.match(layout, /SPARK_WINDOW_TARGET/);
  });
});
