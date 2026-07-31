# Runs the app as-is on any host that gives it a persistent disk
# (Railway, Fly.io, Render...). Vercel is NOT suitable: it is serverless and the
# SQLite file would be wiped on every cold start.

FROM node:22-alpine

WORKDIR /app
COPY . .

ENV NODE_ENV=production
# Mount a volume here so the database survives restarts and redeploys.
ENV CHATMATE_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 5190
CMD ["node", "server.js"]
