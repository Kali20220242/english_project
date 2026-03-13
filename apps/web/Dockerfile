FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/api/package.json services/api/package.json
COPY services/ai-worker/package.json services/ai-worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json

RUN npm ci

COPY . .

RUN npm run build -w @neontalk/web

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app /app

EXPOSE 3000

CMD ["sh", "-c", "npm run start -w @neontalk/web -- -H 0.0.0.0 -p 3000"]
