# fleet-server. Use with compose.yaml (with an HTTPS proxy in front); see "Quick start with Docker" in the README.
FROM node:26.13.1-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY bin ./bin
COPY public ./public
COPY agent ./agent
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production FLEET_HOST=0.0.0.0 FLEET_PORT=3100 FLEET_DB_FILE=/app/data/fleet.db
VOLUME /app/data
EXPOSE 3100
USER node
CMD ["node", "server.js"]
