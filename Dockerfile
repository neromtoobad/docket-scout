# Docket Scout: one image, API + scouting UI on $PORT (default 8030).
#   docker build -t docket-scout .
#   docker run --rm -p 8030:8030 -e SAMPLE_MODE=true docket-scout        # no credentials at all
#   docker run --rm -p 8030:8030 --env-file .env \
#     -e METERLESS_BASE_URL=http://host.docker.internal:8088/v1 \
#     -e ZETARIS_REST_URL=http://host.docker.internal:8888/api/v1.0 docket-scout
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production PORT=8030 HOST=0.0.0.0 SCOUT_DATA=/app/data/runtime

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY . .
RUN npm run web:build && mkdir -p logs data/runtime

EXPOSE 8030
CMD ["npx", "tsx", "src/server.ts"]
