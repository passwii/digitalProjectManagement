import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

/**
 * 站点图标（favicon）回归守卫 —— BLF-1360。
 *
 * 事故：BLF-1354 为了加 iOS 主屏幕图标，在根布局里写了
 *
 *     icons: { apple: "/icons/apple-touch-icon.png" }
 *
 * 结果浏览器标签页的地球图标回来了。原因是 Next 的元数据合并逻辑
 *（next/dist/lib/metadata/resolve-metadata.js，`leafSegmentStaticIcons` 分支）：
 * 文件约定图标（`app/icon.svg`）**只在 metadata 没有 `icons` 字段时**才会被合进
 * `<head>`；一旦 `icons` 变成真值，`app/icon.svg` 就被静默丢弃 —— 不报错、不告警，
 * 只有肉眼能发现。而且 `next build` 依旧全绿，所以 CI 也拦不住。
 *
 * 这里守两件事，都是那次事故的真实缺口：
 *   1. `icons` 里必须显式声明 `icon`（否则 `app/icon.svg` 会被丢弃）；
 *   2. 声明的每个图标都必须真的存在（引用了不存在的文件同样是地球图标）。
 *
 * 只用源码 + 文件系统断言，不跑 Next 构建：跑构建要十几秒，而这两条不变式
 * 读源码就能确定。
 */

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/** 站点 manifest 图标由共享 PWA 常量声明；middleware 直接返回相应清单对象。 */

/** 取出 `icons: { ... }` 整块（含嵌套数组），按大括号配平，避免正则跨块误匹配。 */
function iconsBlock(): string {
  const layout = source("app/layout.tsx");
  const start = layout.indexOf("icons:");
  assert.ok(start >= 0, "根布局 metadata 里找不到 icons 字段");
  const open = layout.indexOf("{", start);
  assert.ok(open >= 0, "icons 字段不是对象字面量");

  let depth = 0;
  for (let i = open; i < layout.length; i += 1) {
    if (layout[i] === "{") depth += 1;
    else if (layout[i] === "}") {
      depth -= 1;
      if (depth === 0) return layout.slice(open, i + 1);
    }
  }
  assert.fail("icons 对象没有闭合，源码结构异常");
}

/** icons 块里所有以 `/` 开头的资源路径。 */
function declaredIconPaths(): string[] {
  return Array.from(iconsBlock().matchAll(/"(\/[\w./-]+)"/g), ([, path]) => path);
}

/** `/icons/x.png` → `public/icons/x.png`；`/icon.svg` → 文件约定路由 `app/icon.svg`。 */
function resolvesToFile(publicPath: string): boolean {
  const relative = publicPath.replace(/^\//, "");
  return (
    existsSync(resolve(process.cwd(), "public", relative)) ||
    existsSync(resolve(process.cwd(), "app", relative))
  );
}

describe("站点图标（favicon）", () => {
  it("根布局显式声明 icon，不让 app/icon.svg 被 metadata.icons 挤掉", () => {
    const block = iconsBlock();
    assert.match(
      block,
      /\bicon\s*:/,
      "metadata.icons 只写 apple 时，Next 会静默丢弃 app/icon.svg，标签页退回地球图标（BLF-1360）",
    );
    assert.match(block, /"\/icon\.svg"/, "app/icon.svg 需要作为矢量图标显式声明");
  });

  it("声明的每个图标文件都真实存在", () => {
    const paths = declaredIconPaths();
    assert.ok(paths.length > 0, "metadata.icons 里没有声明任何图标路径");

    const missing = paths.filter((path) => !resolvesToFile(path));
    assert.deepEqual(missing, [], `metadata.icons 引用了不存在的文件：${missing.join(", ")}`);
  });

  it("PNG 兜底存在：不支持 SVG favicon 的浏览器不会退回地球图标", () => {
    const block = iconsBlock();
    // Safari 与老 Firefox 不认 SVG favicon；只给 SVG 时它们同样显示地球。
    assert.match(block, /"\/icons\/icon-192\.png"/, "缺少 192 PNG favicon，Safari 会显示地球图标");
  });

  it("manifest 的图标同样都能取到", () => {
    const manifest = source("app/manifest.webmanifest/route.ts");
    const paths = Array.from(manifest.matchAll(/src:\s*"(\/[\w./-]+)"/g), ([, path]) => path);
    assert.ok(paths.length > 0, "manifest 里没有声明任何图标");

    const missing = paths.filter((path) => !resolvesToFile(path));
    assert.deepEqual(missing, [], `manifest 引用了不存在的文件：${missing.join(", ")}`);
  });

  it("两个站点的 manifest 图标同样都能取到（BLF-1389 / BLF-1400）", () => {
    // 两个站点的清单由 middleware 返回，图标声明在**共享常量**
    // `lib/pwaManifest.ts` 的 `PWA_ICONS` 里。引用不存在的文件会让浏览器
    // 回退到默认图标，所以确认共享图标都存在且两个 manifest 都使用公共构造器。
    const shared = source("lib/pwaManifest.ts");
    const sharedPaths = Array.from(
      shared.matchAll(/src:\s*"(\/[\w./-]+)"/g),
      ([, path]) => path,
    );
    assert.ok(sharedPaths.length > 0, "lib/pwaManifest.ts 里没有声明任何图标");

    const missing = sharedPaths.filter((path) => !resolvesToFile(path));
    assert.deepEqual(missing, [], `共享图标常量引用了不存在的文件：${missing.join(", ")}`);

    assert.match(
      shared,
      /SPARK_PWA_MANIFEST\s*=\s*buildPwaManifest\(/,
      "spark manifest 没有使用共享构造器",
    );
    assert.match(
      shared,
      /STREAM_MONITOR_PWA_MANIFEST\s*=\s*buildPwaManifest\(/,
      "stream-monitor manifest 没有使用共享构造器",
    );
  });
});
