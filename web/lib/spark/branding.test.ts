import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("云电竞管理平台品牌契约", () => {
  const desktopLayout = source('app/(dashboard)/layout.tsx');
  const mobileEntry = source("components/mobile/sheets/MineSheet.tsx");
  const sparkShell = source("components/spark/SparkShell.tsx");
  const sparkMetadata = source("app/spark/layout.tsx");
  const changelog = source("lib/changelog.ts");

  it("桌面与移动入口使用统一站点名称并保留 /spark 目标", () => {
    assert.match(desktopLayout, /"\/spark": "云电竞管理平台"/);
    assert.match(desktopLayout, /n\.href === "\/spark"/);
    assert.match(mobileEntry, /href="\/spark"[\s\S]*?title="云电竞管理平台"/);
    assert.doesNotMatch(mobileEntry, /NebulaCloud|Spark 演示站/);
  });

  it("桌面侧栏用独立浏览上下文打开站点，手机端改为同页导航（BLF-1389）", () => {
    // 桌面端：两个站点各有自己的浏览上下文（`target`），桌面用户能同时开两个窗口。
    assert.match(desktopLayout, /target=\{[\s\S]*?SPARK_WINDOW_TARGET/);
    // 手机端：`target` 会在手机上开出一堆新标签页（底部多一条地址栏、
    // 回主工作台要连点好几次「返回」），所以手机端入口**不带** target。
    assert.doesNotMatch(
      mobileEntry,
      /target=\{SPARK_WINDOW_TARGET\}/,
      "手机端入口不应再带 target：手机是单任务，同页导航才对",
    );
  });

  it("Spark 壳层的品牌、可访问名称和 metadata 使用统一名称", () => {
    assert.match(sparkShell, /aria-label="云电竞管理平台侧栏"/);
    assert.match(sparkShell, /aria-label="关闭云电竞管理平台导航"/);
    assert.match(sparkShell, /aria-label="打开云电竞管理平台导航"/);
    assert.match(sparkShell, /<strong>云电竞<span>管理平台<\/span><\/strong>/);
    assert.doesNotMatch(sparkShell, /NebulaCloud|CLOUD ESPORTS OS|Spark 导航/);
    assert.match(sparkMetadata, /title:\s*\{\s*absolute:\s*"云电竞管理平台"/);
    assert.match(sparkMetadata, /description:.*云电竞管理平台/);
    assert.doesNotMatch(sparkMetadata, /NebulaCloud/);
    assert.match(changelog, /title: "云电竞管理平台"/);
    assert.doesNotMatch(changelog, /新增可公开访问的 NebulaCloud 演示站/);
  });

  it("站点仍从 /spark 重定向到现有总览路由", () => {
    assert.match(source("app/spark/page.tsx"), /redirect\("\/spark\/dashboard"\)/);
  });
});
