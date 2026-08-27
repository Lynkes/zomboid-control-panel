FROM docker:27-cli

RUN apk add --no-cache nodejs curl tar docker-cli-compose

WORKDIR /controller
COPY docker/all-in-one/updater/server.js ./server.js
COPY docker/all-in-one/updater/containerLifecycle.cjs ./containerLifecycle.cjs

EXPOSE 3100
ENTRYPOINT []
CMD ["node", "server.js"]