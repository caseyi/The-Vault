# Node 22 for the built-in node:sqlite (no native better-sqlite3 addon to compile)
FROM node:22-alpine

# Build deps kept for sharp's optional native bits; node:sqlite needs none.
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .

ENV PORT=3001
ENV DB_PATH=/data/vault.db
ENV IMAGES_DIR=/data/images
ENV LIBRARY_PATH=/library

EXPOSE 3001
# --disable-warning hushes the node:sqlite "experimental" notice (inherited by the scan worker too)
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
