# syntax=docker/dockerfile:1
#
# Baldwin engine and keeper (one image, the process is chosen by the command).
#
# Build context is the REPOSITORY ROOT, because the engine imports ../shared:
#   docker build -f engine/Dockerfile -t baldwin-engine .
# Run:
#   engine:  docker run ... baldwin-engine                      (default command)
#   keeper:  docker run ... baldwin-engine src/keeper/main.ts
#
# NOTE: written without a Docker daemon at hand; see the README ("Docker").

# ---- production dependencies only (tsx is a runtime dependency: sources run as TypeScript)
FROM node:22-slim AS deps
WORKDIR /app/engine
COPY engine/package.json engine/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app/engine
COPY --from=deps /app/engine/node_modules ./node_modules
COPY shared/src /app/shared/src
COPY engine/package.json ./
COPY engine/src ./src

# State lives in /data: the engine's SQLite store, the keeper's cursor file.
RUN mkdir -p /data /deployments && chown node:node /data
VOLUME ["/data"]
ENV STORE_PATH=/data/engine.sqlite \
    KEEPER_STATE_PATH=/data/keeper-state.json \
    DEPLOYMENT_PATH=/deployments/arbitrumSepolia.json \
    HOST=0.0.0.0 \
    PORT=8080

# Not root. (uid 1000 in the official image.)
USER node
EXPOSE 8080

# node is PID 1 and handles SIGTERM itself (graceful shutdown); give it more than
# SHUTDOWN_TIMEOUT_MS before SIGKILL (docker stop -t 45, or stop_grace_period).
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx"]
CMD ["src/main.ts"]
