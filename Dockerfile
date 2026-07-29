FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY db.js server.js ./
COPY public ./public

EXPOSE 3000
CMD ["node", "server.js"]
