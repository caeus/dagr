FROM node:22-alpine

RUN apk add --no-cache docker-cli docker-cli-buildx

WORKDIR /dagr

COPY dist/dagr.js ./dagr.js

LABEL org.opencontainers.image.source="https://github.com/caeus/dagr"

ENV REPO_ROOT=/repo

ENTRYPOINT ["node", "--experimental-vm-modules", "/dagr/dagr.js"]
