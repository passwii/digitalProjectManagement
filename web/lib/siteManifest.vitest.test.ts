import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ROOT_SITE,
  SPARK_SITE,
  STREAM_MONITOR_SITE,
  siteIdentityFor,
} from "./siteIdentity";

/**
 * 站点级 PWA 身份契约（BLF-1389）。
 *
 * 守三件事：
 *   1. **每个站点有自己的 manifest**，且字段齐全（standalone / scope /
 *      theme_color / icons / shortcuts）；
 *   2. **`<link rel="manifest">` 指向该站点自己那份**，不是根那份 ——
 *      这是整件事的核心：指向根就等于「装进去还是主工作台」；
 *   3. **反向用例**：根页面的 manifest link 仍然指向 `/manifest.webmanifest`
 *      （迁移根 manifest 的最大风险是把根站点自己的安装能力弄丢）。
 *
 * ⚠️ 为什么这些断言是**读源码 + 读文件**，不是跑构建：
 * manifest 的元数据合并逻辑（Next 的 `staticFilesMetadata.manifest`
 * 无条件覆盖 layout 的 `metadata.manifest`）只有在真跑一次 Next 时才看得见，
 * 但「布局有没有写 `metadata.manifest`」「根目录还有没有 `app/manifest.ts`」
 * 这两件事读源码就能确定 —— 而后者正是**站点 manifest 能不能生效**的开关。
 * 真正的端到端效果由 `scripts/acceptance_blf1389_mobile.py` 在真浏览器里验。
 */

/** 站点身份 → 静态 manifest 文件路径。 */
const SITE_MANIFEST_FILES: Record<string, string> = {
  [SPARK_SITE.manifest]: "public/spark/manifest.webmanifest",
  [STREAM_MONITOR_SITE.manifest]: "public/stream-monitor/manifest.webmanifest",
};

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8");
}

function readManifest(relative: string): Record<string, unknown> {
  return JSON.parse(read(relative)) as Record<string, unknown>;
}

/**
 * 图标路径 → 真实文件。
 *
 * 两种落点都算：`/icons/x.png` 是 `public/` 下的静态文件，
 * `/icon.svg` 是 Next 的**文件约定**路由（`app/icon.svg`）。
 */
function iconFileExists(publicPath: string): boolean {
  const relative = publicPath.replace(/^\//, "");
  return (
    existsSync(resolve(process.cwd(), "public", relative)) ||
    existsSync(resolve(process.cwd(), "app", relative))
  );
}

describe("站点级 PWA 身份：manifest 契约（BLF-1389）", () => {
  it("根目录不再有 app/manifest.ts（文件约定会覆盖 layout 的 metadata.manifest）", () => {
    // Next 的元数据合并里，文件约定形式的 manifest 会被写进
    // `staticFilesMetadata.manifest`，在 `mergeStaticMetadata` 里**无条件覆盖**
    // layout 显式写的 `metadata.manifest`。
    // 只要 `app/manifest.ts` 还在，两个站点的 `<link rel="manifest">` 就永远
    // 指向根那份 —— 站点自己的 PWA 身份形同虚设。
    expect(existsSync(resolve(process.cwd(), "app/manifest.ts"))).toBe(false);
    // 迁到 route.ts 之后，元数据只由 `metadata.manifest` 说了算。
    expect(existsSync(resolve(process.cwd(), "app/manifest.webmanifest/route.ts"))).toBe(true);
  });

  it("根布局显式声明 metadata.manifest（route.ts 形式不会被自动注入 <head>）", () => {
    // 实测：根 manifest 迁成 route.ts 但根布局不写 `metadata.manifest` 时，
    // 根页面的 HTML 里**一条 manifest link 都没有**（比改之前更糟）。
    const layout = read("app/layout.tsx");
    expect(layout).toMatch(/manifest:\s*"\/manifest\.webmanifest"/);
  });

  it("两个站点的布局各自声明 metadata.manifest，指向自己的那份", () => {
    expect(read("app/spark/layout.tsx")).toMatch(
      /manifest:\s*"\/spark\/manifest\.webmanifest"/,
    );
    expect(read("app/stream-monitor/layout.tsx")).toMatch(
      /manifest:\s*"\/stream-monitor\/manifest\.webmanifest"/,
    );
  });

  it("两个站点的 manifest 文件都存在，且 URL 与布局声明的一致", () => {
    for (const [url, file] of Object.entries(SITE_MANIFEST_FILES)) {
      expect(existsSync(resolve(process.cwd(), file)), `${file} 不存在`).toBe(true);
      // URL → 文件路径的映射必须与布局里写的 manifest 一致（否则 404）。
      expect(url).toBe(`/${file.replace(/^public\//, "")}`);
    }
  });

  it("站点 manifest 字段齐全（standalone / scope / 主题色 / 图标 / 快捷方式）", () => {
    for (const [url, file] of Object.entries(SITE_MANIFEST_FILES)) {
      const manifest = readManifest(file);

      expect(manifest.display, `${file} 必须是 standalone`).toBe("standalone");
      expect(manifest.lang, `${file} 缺 lang`).toBe("zh-CN");

      // scope 限定在各自站点路径下 —— 浏览器靠它判定「装的是哪个应用」，
      // scope 写错会把主工作台一起装进去（或装成主应用）。
      const scope = String(manifest.scope ?? "");
      expect(scope.startsWith("/"), `${file} 的 scope 必须是站内路径`).toBe(true);
      expect(url.startsWith(scope), `${file} 的 scope ${scope} 必须覆盖它自己的 URL ${url}`).toBe(true);

      // start_url 指向站点首页（不是主工作台）。
      const startUrl = String(manifest.start_url ?? "");
      expect(startUrl.startsWith(scope), `${file} 的 start_url ${startUrl} 必须落在 scope 内`).toBe(true);
      expect(startUrl).not.toBe("/");

      // 主题色与布局导出的 viewport.themeColor 同值。
      expect(manifest.theme_color, `${file} 缺 theme_color`).toBeTruthy();
      expect(manifest.background_color, `${file} 缺 background_color`).toBeTruthy();

      // 图标：至少 192 / 512 / maskable 三档，且都指向 public/icons/ 下真实存在的文件。
      const icons = (manifest.icons ?? []) as Array<Record<string, unknown>>;
      expect(icons.length, `${file} 没有声明图标`).toBeGreaterThan(0);
      const sizes = icons.map((icon) => String(icon.sizes));
      const purposes = icons.map((icon) => String(icon.purpose));
      expect(sizes, `${file} 缺 192x192 图标`).toContain("192x192");
      expect(sizes, `${file} 缺 512x512 图标`).toContain("512x512");
      expect(purposes, `${file} 缺 maskable 图标`).toContain("maskable");
      for (const icon of icons) {
        const src = String(icon.src ?? "");
        expect(src.startsWith("/"), `${file} 的图标路径必须是站内绝对路径`).toBe(true);
        expect(
          iconFileExists(src),
          `${file} 的图标 ${src} 既不在 public/ 下也不是 app/ 下的文件约定路由`,
        ).toBe(true);
      }

      // 快捷方式：指向站点内的高频页面。
      const shortcuts = (manifest.shortcuts ?? []) as Array<Record<string, unknown>>;
      expect(shortcuts.length, `${file} 没有声明 shortcuts`).toBeGreaterThan(0);
      for (const shortcut of shortcuts) {
        const shortcutUrl = String(shortcut.url ?? "");
        expect(
          shortcutUrl.startsWith(scope),
          `${file} 的快捷方式 ${shortcutUrl} 落在 scope ${scope} 之外`,
        ).toBe(true);
      }
    }
  });

  it("站点 manifest 用中文品牌，不出现英文品牌（BLF-1397 口径）", () => {
    for (const file of Object.values(SITE_MANIFEST_FILES)) {
      const raw = read(file);
      expect(raw, `${file} 出现了英文品牌`).not.toMatch(/Stream Monitor|STREAM MONITOR/);
      expect(raw, `${file} 出现了旧品牌`).not.toMatch(/NebulaCloud/i);
    }
  });

  it("站点 manifest 的 name 与布局的标题、站点身份三处一致", () => {
    expect(readManifest("public/spark/manifest.webmanifest").name).toBe(SPARK_SITE.name);
    expect(readManifest("public/stream-monitor/manifest.webmanifest").name).toBe(
      STREAM_MONITOR_SITE.name,
    );
    // 布局标题也是同一套品牌名。
    expect(read("app/spark/layout.tsx")).toMatch(/absolute:\s*"云电竞管理平台"/);
    expect(read("app/stream-monitor/layout.tsx")).toMatch(/title:\s*"智能音视频平台"/);
  });

  it("根 manifest 的身份仍然是主工作台，且 shortcuts 覆盖两个新平台入口", () => {
    const route = read("app/manifest.webmanifest/route.ts");
    expect(route).toMatch(/name:\s*"数科云办公"/);
    expect(route).toMatch(/scope:\s*"\/"/);
    expect(route).toMatch(/theme_color:\s*"#0F2742"/);
    // 长按主屏幕图标直达两个独立站点。
    expect(route).toMatch(/url:\s*"\/spark\/dashboard"/);
    expect(route).toMatch(/url:\s*"\/stream-monitor\/overview"/);
    // 既有入口不能丢。
    expect(route).toMatch(/url:\s*"\/dashboard"/);
    expect(route).toMatch(/url:\s*"\/approvals"/);
  });

  it("站点的 manifest 免登录可取（middleware 的 PUBLIC_PATHS 命中路径前缀）", () => {
    // `/spark` 与 `/stream-monitor` 都在 PUBLIC_PATHS 里，前缀匹配 → 站点自己的
    // manifest 天然放行，不需要额外改 middleware。
    const middleware = read("middleware.ts");
    const publicBlock = middleware.slice(
      middleware.indexOf("const PUBLIC_PATHS"),
      middleware.indexOf("];"),
    );
    expect(publicBlock).toMatch(/"\/spark"/);
    expect(publicBlock).toMatch(/"\/stream-monitor"/);
  });
});

describe("站点级 PWA 身份：视口契约（BLF-1389）", () => {
  it("两个站点的布局各自导出 viewport，且 viewportFit=cover", () => {
    for (const file of ["app/spark/layout.tsx", "app/stream-monitor/layout.tsx"]) {
      const source = read(file);
      expect(source, `${file} 没有导出 viewport`).toMatch(/export const viewport/);
      expect(source, `${file} 的 viewportFit 必须是 cover`).toMatch(/viewportFit:\s*"cover"/);
      expect(source, `${file} 的 width 必须是 device-width`).toMatch(/width:\s*"device-width"/);
    }
  });

  it("站点的 themeColor 与 manifest 的 theme_color 同值", () => {
    // standalone 启动时状态栏色与页面顶色对不上，就是这两处漂了。
    const sparkLayout = read("app/spark/layout.tsx");
    const sparkManifest = readManifest("public/spark/manifest.webmanifest");
    expect(sparkLayout).toContain(String(sparkManifest.theme_color));
    expect(sparkLayout).toContain(SPARK_SITE.themeColor);

    const avLayout = read("app/stream-monitor/layout.tsx");
    const avManifest = readManifest("public/stream-monitor/manifest.webmanifest");
    expect(avLayout).toContain(String(avManifest.theme_color));
    expect(avLayout).toContain(STREAM_MONITOR_SITE.themeColor);
  });

  it("站点的 themeColor 不再是主工作台的深蓝（否则状态栏与页面顶色对不上）", () => {
    expect(SPARK_SITE.themeColor).not.toBe(ROOT_SITE.themeColor);
    expect(STREAM_MONITOR_SITE.themeColor).not.toBe(ROOT_SITE.themeColor);
  });

  it("智能音视频平台是深浅双主题：viewport 给深浅两份 themeColor", () => {
    const layout = read("app/stream-monitor/layout.tsx");
    expect(layout).toMatch(/prefers-color-scheme:\s*dark/);
    expect(layout).toMatch(/prefers-color-scheme:\s*light/);
    expect(STREAM_MONITOR_SITE.lightThemeColor).toBeTruthy();
  });

  it("根布局的 themeColor 仍然是主工作台的深蓝（不能被站点改掉）", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toMatch(/themeColor:\s*"#0F2742"/);
  });
});

describe("站点级 PWA 身份：按路径取身份（BLF-1389）", () => {
  it("站点路径取站点身份，其余取主工作台", () => {
    expect(siteIdentityFor("/spark")).toBe(SPARK_SITE);
    expect(siteIdentityFor("/spark/dashboard")).toBe(SPARK_SITE);
    expect(siteIdentityFor("/stream-monitor")).toBe(STREAM_MONITOR_SITE);
    expect(siteIdentityFor("/stream-monitor/overview")).toBe(STREAM_MONITOR_SITE);
    expect(siteIdentityFor("/dashboard")).toBe(ROOT_SITE);
    expect(siteIdentityFor("/projects")).toBe(ROOT_SITE);
  });

  it("前缀必须带路径边界（/sparky 不是 /spark）", () => {
    expect(siteIdentityFor("/sparky")).toBe(ROOT_SITE);
    expect(siteIdentityFor("/stream-monitorish")).toBe(ROOT_SITE);
  });

  it("拿不到路径时回落到主工作台（SSR 首帧）", () => {
    expect(siteIdentityFor(null)).toBe(ROOT_SITE);
    expect(siteIdentityFor(undefined)).toBe(ROOT_SITE);
    expect(siteIdentityFor("")).toBe(ROOT_SITE);
  });
});
