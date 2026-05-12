# Stage 1: Build
FROM node:20-slim AS builder
WORKDIR /app
ENV HUSKY=0
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY . .
RUN npm run build

# Stage 2: Production
FROM node:20-slim AS production
WORKDIR /app
ENV NODE_ENV=production
ENV HUSKY=0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["./entrypoint.sh"]
