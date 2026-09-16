FROM node:20-alpine

WORKDIR /app

# 前端在构建期需要知道 API 基址（Next.js 会把它编进产物）
ARG NEXT_PUBLIC_API_BASE=http://localhost:8001/api/v1
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web ./
RUN npm run build

EXPOSE 3001
CMD ["npx", "next", "start", "--port", "3001", "--hostname", "0.0.0.0"]
