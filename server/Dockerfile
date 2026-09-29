FROM node:20-bookworm-slim

# ffmpeg powers the whole compression tier: Opus audio, H.264 ladders,
# WebP slide extraction. Without it the transcoder cannot run.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=optional
COPY . .

ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "src/index.js"]
