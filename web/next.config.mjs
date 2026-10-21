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
  /**
   * 信任反代传来的 Host 头（BLF-1400）。
   *
   * 背景：生产是 Caddy(HTTPS 443) → web(3001) 的反代。Next 拼**绝对**重定向
   * URL 时用的是它**启动时**的 hostname + port（next-server.js 的 initURL：
   * `${protocol}://${this.fetchHostname}:${this.port}${req.url}`），而不是请求
   * 的 Host 头 —— 于是登录重定向会跳到 http://0.0.0.0:3001/login，
   * 浏览器直接连不上（实测 ERR_SSL_PROTOCOL_ERROR）。
   *
   * trustHostHeader 让 Next 改用请求的 Host 头拼 URL，也就是浏览器真正
   * 访问的那个域名 —— 这正是反代场景下应有的行为。
   *
   * ⚠️ 生效前提：**fetchHostname 必须是空**。Next 的判断是
   *    `this.fetchHostname && this.port ? <用 fetchHostname> : <用 Host 头>`
   *    —— 前者为真时**根本不会**走 Host 头分支。而 fetchHostname 来自
   *    standalone server.js 的 `process.env.HOSTNAME || '0.0.0.0'`。
   *    所以 docker/web.Dockerfile 里必须把 HOSTNAME 设为空字符串
   *    （空的 HOSTNAME 让 server.listen(port, '') 监听所有网卡，行为不变），
   *    否则这项配置不生效。
   *
   * 顺带一提：trustHostHeader 分支的协议是 https 写死的，但站点的对外入口
   * 永远是 HTTPS（Caddy 终止 TLS），所以这里没有 http/https 不一致的问题。
   */
  experimental: {
    trustHostHeader: true,
  },
};
export default nextConfig;
