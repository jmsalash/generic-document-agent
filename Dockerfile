# Generic Document Agent: the relay, its setup page, the demo page, the widget and the Cloudflare uploader, in one container.
FROM node:22-slim
ENV NODE_ENV=production PORT=8792 HTTPS_PORT=8793 DATA_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY relay ./relay
COPY cloud ./cloud
COPY widget ./widget
COPY voices ./voices
COPY LICENSE README.md ./
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
# Your key, document and settings live here: keep it on a volume so they survive updates.
VOLUME /app/data
EXPOSE 8792 8793
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8792/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "relay/server.js"]
