# syntax=docker/dockerfile:1
# Builds the API server (apps/server). Build from the repo root:
#   docker build -t boda-dispatch-server .

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN npm ci --include-workspace-root \
  -w @boda-dispatch/shared -w @boda-dispatch/server
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
RUN npm run build -w @boda-dispatch/shared && npm run build -w @boda-dispatch/server

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN npm ci --omit=dev -w @boda-dispatch/shared -w @boda-dispatch/server \
  && npm cache clean --force
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY apps/server/drizzle ./apps/server/drizzle
WORKDIR /app/apps/server
USER node
EXPOSE 4000
CMD ["npm", "start"]
