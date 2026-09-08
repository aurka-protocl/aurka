FROM node:22.14.0-bookworm-slim

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/graph/package.json packages/graph/package.json
COPY packages/services/package.json packages/services/package.json
COPY packages/wallet/package.json packages/wallet/package.json
COPY packages/agents/watchtower/package.json packages/agents/watchtower/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts=false

COPY packages/shared packages/shared
COPY packages/graph packages/graph
COPY packages/services packages/services
COPY packages/wallet packages/wallet
COPY packages/agents/watchtower packages/agents/watchtower
RUN pnpm --filter @aurka/services... build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATABASE_URL=/data/aurka.sqlite
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:8787/ready').then(r=>r.json()).then(body=>process.exit(body.ok&&body.data.status==='ready'?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@aurka/services", "start"]
