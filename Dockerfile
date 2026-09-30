FROM node:24-slim

ENV NODE_ENV=production \
    DATA_DIR=/app/dados \
    PORT=3000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public

RUN mkdir -p /app/dados && chown -R node:node /app/dados
USER node
VOLUME /app/dados
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/publico').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
