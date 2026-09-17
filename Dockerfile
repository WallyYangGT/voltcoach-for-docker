ARG NODE_IMAGE=docker.io/library/node:24-slim
ARG VERSION=latest
FROM ${NODE_IMAGE}
ARG VERSION=latest

WORKDIR /app

# 非密钥环境变量默认值：输入/输出/训练库路径与 Web 服务端口
# （AI 密钥等用户配置在 Web 设置页维护，存训练库，不走环境变量）
# TZ 决定 AI 报告呈现训练时间所用时区：训练数据一律 UTC 存储，若容器跑在
# 默认 UTC，本地傍晚的骑行会以「中午」呈现给 AI。默认按项目主要用户设为
# 上海时区，其它时区请在 docker-compose.yml / docker run 覆盖（见 DEPLOY.md）。
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    FIT_INPUT_DIR=/input \
    FIT_OUTPUT_DIR=/output \
    FIT_DB_PATH=/app/db/fitness.db \
    PORT=3000 \
    APP_VERSION=${VERSION}

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "run", "web"]
