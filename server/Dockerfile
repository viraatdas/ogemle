# Build stage
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server ./server
RUN pnpm install --frozen-lockfile
RUN pnpm --filter ogemle-server build

# Production image
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/tsconfig.json ./server/
COPY --from=build /app/server/dist ./server/dist
RUN pnpm install --filter ogemle-server --prod --frozen-lockfile
EXPOSE 8080
CMD ["pnpm", "--filter", "ogemle-server", "start"]
