import { defineConfig } from "vitest/config";

/**
 * vitest（`test:motion`）的测试集合。
 *
 * 前端有两套 runner，`pnpm test` 会依次跑两套（见 package.json 的 `test`）：
 *   · `test:unit`  —— `tsc -p tsconfig.test.json` + `node --test .test-dist/lib/`
 *   · `test:motion` —— 本文件
 *
 * 命名约定（决定一个测试走哪套）：
 *   · `lib/*.test.ts`          → node:test，由 tsconfig.test.json 的 include 自动收走
 *   · `lib/*.vitest.test.ts`   → vitest，需要 vitest 的 expect/mock 或浏览器全局时用
 *   · `lib/activityCore.test.ts` → 历史遗留的 vitest 文件（main 的动效工作引入），
 *                                 保留原名以免与在途 PR 冲突，由下面显式包含
 *
 * 为什么这么分：node:test 的 tsconfig 只有 ES2022 类型、没有 DOM，
 * 而 vitest 那套测试要么需要 `expect`，要么需要 mock `XMLHttpRequest` 等
 * 浏览器全局（进而把 `api.ts` 的 DOM 引用拉进编译）。归属必须唯一——
 * 两边都收会得到一条假失败（vitest 的 expect 在 node:test 下不可用）。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/*.vitest.test.ts", "lib/activityCore.test.ts"],
  },
});
