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

# Pinned to a patch release: the engine needs node:sqlite (Node >= 22.13), and a moving
# tag would change the runtime under a long-lived deployment.
ARG NODE_IMAGE=node:22.14.0-slim

# ---- production dependencies only (tsx is a runtime dependency: sources run as TypeScript)
FROM ${NODE_IMAGE} AS deps
WORKDIR /app/engine
COPY engine/package.json engine/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime
FROM ${NODE_IMAGE}
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

# The process handles SIGTERM itself (graceful shutdown). With `docker run --init` or
# compose's `init: true` (as in docker-compose.testnet.yml) tini is PID 1 and forwards
# the signal; without it node is PID 1, which also works. Either way give it more than
# SHUTDOWN_TIMEOUT_MS before SIGKILL (docker stop -t 45, or stop_grace_period).
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx"]
CMD ["src/main.ts"]
