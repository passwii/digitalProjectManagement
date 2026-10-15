# 生产 web 镜像：两段式。构建段带 devDependencies 干活，运行段只留 `next build`
# 真正 trace 出来的运行时文件。
#
# 为什么必须拆：单段构建的镜像 955MB，实测构成是
#   node_modules 496MB（typescript/esbuild/eslint/@next/swc 全平台的都进来了，
#   其中绝大部分只在构建期有用）
#   .next 224MB（其中 214MB 是 .next/cache —— 构建缓存对运行毫无用处）
# 每轮部署还会把上一代留成 955MB 的悬空镜像，代价被乘了两次。
# 拆完运行段只剩 base + 被 trace 的 node_modules + static + public。
FROM node:20-alpine AS builder

WORKDIR /app

# 前端在构建期需要知道 API 基址（Next.js 会把它编进产物）
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG NEXT_PUBLIC_API_BASE=http://localhost:8001/api/v1
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE

COPY web/package.json web/package-lock.json ./
RUN npm ci --registry="${NPM_REGISTRY}" --maxsockets 2

COPY web ./
RUN npm run build

# 运行段。`next build` 已经把 trace 到的 node_modules 放进 .next/standalone，
# 但 `.next/static` 和 `public` 按官方文档必须手工搬进去，漏了就是白屏 + 404。
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
# standalone 的 server.js 从环境变量取监听地址；这两个值不设就等于 `next start`
# 的默认端口，且可能只绑 127.0.0.1——容器外就再也探不到 3001。
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

# --chown 让 next 运行时能写 .next/cache（fetch/router 缓存），同时不必以 root 跑。
COPY --chown=node:node --from=builder /app/.next/standalone ./
COPY --chown=node:node --from=builder /app/.next/static ./.next/static
COPY --chown=node:node --from=builder /app/public ./public

EXPOSE 3001
USER node
CMD ["node", "server.js"]
