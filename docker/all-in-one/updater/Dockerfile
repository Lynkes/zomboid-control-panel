# Pinned by digest (Dependabot proposes updates): this container holds the
# Docker socket.
FROM docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c

RUN apk add --no-cache nodejs curl tar docker-cli-compose

WORKDIR /controller
COPY docker/all-in-one/updater/server.js ./server.js
COPY docker/all-in-one/updater/containerLifecycle.cjs ./containerLifecycle.cjs

EXPOSE 3100
ENTRYPOINT []
CMD ["node", "server.js"]