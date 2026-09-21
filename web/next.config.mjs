import nextEnv from "@next/env";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { loadEnvConfig } = nextEnv;
const currentDir = path.dirname(fileURLToPath(import.meta.url));
loadEnvConfig(path.resolve(currentDir, ".."));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // react-pdf 的 PDF worker 在 Next 15 前需由 Terser 处理 ESM 输出。
  swcMinify: false,
};
export default nextConfig;
