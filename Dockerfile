# Runs the app as-is on any host that gives it a persistent disk
# (Railway, Fly.io, Render...). Vercel is NOT suitable: it is serverless and the
# SQLite file would be wiped on every cold start.

FROM node:22-alpine

WORKDIR /app
COPY . .

ENV NODE_ENV=production

# The database must live on a mounted volume so it survives restarts and
# redeploys. Railway rejects the Docker VOLUME instruction: attach the volume in
# the service settings instead, mounted on the path below.
ENV CHATMATE_DATA_DIR=/data

EXPOSE 5190
CMD ["node", "server.js"]
