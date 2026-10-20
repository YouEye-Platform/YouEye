# Run from the repository root: docker build -f control-panel/Dockerfile .
FROM node:24.22.0-bookworm-slim AS build
WORKDIR /source
RUN npm install --global pnpm@10.6.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY control-panel/package.json ./control-panel/package.json
COPY ui/package.json ./ui/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ARG YOUEYE_SOURCE_COMMIT
ENV YOUEYE_SOURCE_COMMIT=$YOUEYE_SOURCE_COMMIT
RUN pnpm --dir control-panel run build
# Flatten the selected application without selecting an unrelated server entrypoint.
RUN set -eu; root=control-panel/.next/standalone; if [ -f "$root/control-panel/server.js" ]; then root="$root/control-panel"; fi; test -f "$root/server.js"; cp -a "$root" /standalone

FROM node:24.22.0-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /standalone/ ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
