FROM ghcr.io/pnpm/pnpm:11.23.0 AS build
RUN pnpm runtime set node 26 -g
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM ghcr.io/pnpm/pnpm:11.23.0 AS prune
RUN pnpm runtime set node 26 -g
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:26-slim
WORKDIR /app
COPY --from=prune /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server.js ./server.js

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
