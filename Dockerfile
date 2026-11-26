# syntax=docker/dockerfile:1

# Single image for the Next.js app and the worker process (worker runs via tsx).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# postinstall runs `prisma generate`, which needs the schema and a DATABASE_URL placeholder.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN npm ci

FROM deps AS build
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/worker ./worker
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/public ./public
COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/package.json ./package.json
EXPOSE 3000
CMD ["npm", "run", "start"]
