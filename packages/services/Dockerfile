FROM node:22-bookworm-slim

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/services/package.json packages/services/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts=false

COPY packages/shared packages/shared
COPY packages/services packages/services
RUN pnpm --filter @aurka/shared build && pnpm --filter @aurka/services build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATABASE_URL=/data/aurka.sqlite
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:8787/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@aurka/services", "start"]
