FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# fonts for server-side broadcast rendering + tini for clean signal handling, so
# ffmpeg gets a chance to close its RTMP session on redeploy
RUN apk add --no-cache tini font-dejavu && \
    fc-cache -f >/dev/null 2>&1 || true

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY scripts ./scripts

ENV PORT=3000 HOST=0.0.0.0 WDP_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
