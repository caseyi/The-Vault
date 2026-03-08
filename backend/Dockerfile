FROM node:20-alpine

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
CMD ["node", "server.js"]
