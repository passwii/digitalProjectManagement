import nextEnv from "@next/env";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { loadEnvConfig } = nextEnv;
const currentDir = path.dirname(fileURLToPath(import.meta.url));
loadEnvConfig(path.resolve(currentDir, ".."));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 只有生产镜像需要 standalone 产物：镜像里只搬 `.next/standalone`，不搬整包
  // node_modules + 构建缓存（955MB → 162MB，见 docker/web.Dockerfile）。
  //
  // 用环境变量开关而不是写死的原因：`next start` 与 standalone 不兼容，Next 会
  // 直接警告 “next start does not work with output: standalone”。而本地
  // docker-compose.local.yml 的 web 走的正是 `npm run build && npm run start`，
  // 所以这个开关必须由镜像构建阶段自己打开（ENV NEXT_BUILD_STANDALONE=1），
  // 本地开发行为保持一模一样。
  output: process.env.NEXT_BUILD_STANDALONE === "1" ? "standalone" : undefined,
  // react-pdf 的 PDF worker 在 Next 15 前需由 Terser 处理 ESM 输出。
  swcMinify: false,
};
export default nextConfig;
