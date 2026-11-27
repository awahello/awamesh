# awamesh 运行镜像
FROM node:22-alpine

WORKDIR /app

# 只拷运行所需，保持镜像小
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    AWA_PORT=18443 \
    AWA_HOST=0.0.0.0 \
    AWA_DATA_DIR=/data

# WireGuard 工具 + cloudflared 连接器（面板里可直接启停，天然共享本容器的网络命名空间）
ARG TARGETARCH=amd64
RUN apk add --no-cache su-exec wireguard-tools iproute2 iptables curl \
 && curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${TARGETARCH}" \
 && chmod +x /usr/local/bin/cloudflared

COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh \
 && mkdir -p /data && chown -R node:node /app /data

EXPOSE 18443

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.AWA_PORT||18443;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker/entrypoint.sh"]
