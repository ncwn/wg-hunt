# syntax=docker/dockerfile:1

# Built on the target architecture so better-sqlite3's native module matches it.
FROM node:26-slim AS build
RUN npm install --global pnpm@12.16.1
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm --filter @wg-hunt/server deploy --prod /deploy

FROM node:26-slim
ENV NODE_ENV=production \
    WG_HUNT_HOST=0.0.0.0 \
    WG_HUNT_PORT=8787 \
    WG_HUNT_DATA_DIR=.data \
    WG_HUNT_DASHBOARD_DIR=dashboard
WORKDIR /app
COPY --from=build /deploy/package.json ./package.json
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /deploy/drizzle ./drizzle
COPY --from=build /deploy/dist ./dist
COPY --from=build /repo/apps/dashboard/dist ./dashboard
COPY --from=build --chmod=755 /repo/apps/cli/dist/wg-hunt.mjs /usr/local/bin/wg-hunt
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir .data && chown node:node .data
VOLUME /app/.data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.WG_HUNT_PORT+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.mjs"]
