import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * vitest（`test:motion`）的测试集合。
 *
 * 前端有两套 runner，`pnpm test` 会依次跑两套（见 package.json 的 `test`）：
 *   · `test:unit`  —— `tsc -p tsconfig.test.json` + `node --test .test-dist/lib/`
 *   · `test:motion` —— 本文件
 *
 * 命名约定（决定一个测试走哪套）：
 *   · `lib/*.test.ts`            → node:test，由 tsconfig.test.json 的 include 自动收走；
 *                                   tsconfig.test.json 只收 `.ts`，所以**不能放 JSX**
 *   · `lib/*.vitest.test.ts`     → vitest，需要 vitest 的 expect/mock 或浏览器全局时用（纯逻辑）
 *   · `lib/*.vitest.test.tsx`    → vitest，需要 JSX 渲染真实组件时用（如附件预览弹层、BLF-1125 的身份区）
 *   · `lib/activityCore.test.ts` → 历史遗留的 vitest 文件（main 的动效工作引入），
 *                                  保留原名以免与在途 PR 冲突，由下面显式包含
 *
 * ⚠️ include 必须同时覆盖 `.tsx`：曾经只写了 `*.vitest.test.ts`，
 * 新增的 `.tsx` 组件测试被静默忽略 —— `vitest run` 全绿，但它一条都没跑。
 * 新增测试文件后请确认它真的出现在 `vitest run` 的输出里。
 *
 * 环境按文件选择：默认 node（`api.ts` 那类 mock 浏览器全局的测试自己 mock），
 * 但需要真实 DOM 的测试（如 `lib/modalFocus.dom.vitest.test.ts`）用文件顶部的
 * `@vitest-environment jsdom` 注解切环境，因此不必按环境拆配置文件。
 */
export default defineConfig({
  // 与 tsconfig.json 的 `paths` 对齐：组件里有 `@/lib/...` 形式的导入，
  // vitest 自己不走 tsc 的路径映射，得在这里重复声明一次。
  resolve: {
    alias: { "@": currentDir },
  },
  // 组件是 JSX+TSX，而 tsconfig 里 `jsx: "preserve"`（交给 Next 处理）。
  // vitest 自己经 esbuild 转译，不会读那个字段，默认走 classic runtime 于是报
  // 「React is not defined」——这里显式指定 automatic runtime。
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    include: ["lib/*.vitest.test.ts", "lib/*.vitest.test.tsx", "lib/activityCore.test.ts"],
  },
});
