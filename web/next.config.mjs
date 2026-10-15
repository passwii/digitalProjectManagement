import nextEnv from "@next/env";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { loadEnvConfig } = nextEnv;
const currentDir = path.dirname(fileURLToPath(import.meta.url));
loadEnvConfig(path.resolve(currentDir, ".."));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 生产镜像只搬 `.next/standalone`：里面是 `next build` 按实际 import 树 trace 出来的
  // 运行时文件，而不是整包 node_modules + 构建缓存（955MB → 见 docker/web.Dockerfile）。
  // 本地 `next dev` 不受影响；docker-compose.local.yml 走 `npm run start`，
  // 读的仍是普通 `.next` 产物，两者可以共存。
  output: "standalone",
  // react-pdf 的 PDF worker 在 Next 15 前需由 Terser 处理 ESM 输出。
  swcMinify: false,
};
export default nextConfig;
