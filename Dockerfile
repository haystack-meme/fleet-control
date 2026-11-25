# fleet-server. Use with compose.yaml (MariaDB + an HTTPS proxy); see "Quick start with Docker" in the README.
FROM node:26.13.1-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY bin ./bin
COPY public ./public
COPY agent ./agent
ENV NODE_ENV=production FLEET_HOST=0.0.0.0 FLEET_PORT=3100
EXPOSE 3100
USER node
CMD ["node", "server.js"]
