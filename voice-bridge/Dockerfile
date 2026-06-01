FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg

ARG BUILD_VERSION=unknown
ARG IMAGE_TAG=unknown
ARG GIT_SHA=unknown

LABEL org.opencontainers.image.revision="${GIT_SHA}"
LABEL org.opencontainers.image.version="${IMAGE_TAG}"

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node audio ./audio
COPY --chown=node:node knowledge ./knowledge
COPY --chown=node:node config ./config
RUN mkdir -p /app/recordings && chown -R node:node /app

ENV NODE_ENV=production
ENV VOICE_BRIDGE_HOST=0.0.0.0
ENV VOICE_BRIDGE_PORT=9092
ENV BUILD_VERSION=${BUILD_VERSION}
ENV IMAGE_TAG=${IMAGE_TAG}
ENV GIT_SHA=${GIT_SHA}

EXPOSE 9092

USER node

CMD ["node", "src/index.js"]
