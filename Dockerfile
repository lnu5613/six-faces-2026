FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY . .

ENV PORT=8788
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8788/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
