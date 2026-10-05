# ---------- 构建阶段：node:20-alpine 编译前端静态资源 ----------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# 发布关卡随构建一起跑：不过则镜像构建直接失败（硬拦），机读结论一并打进 dist 供页面自检读取
RUN npm run build && node scripts/release-gate.mjs --no-build

# ---------- 运行阶段：nginx:1.27-alpine 只提供静态文件 ----------
FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]