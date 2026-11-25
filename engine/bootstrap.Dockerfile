FROM node:22-alpine
RUN apk add --no-cache docker-cli docker-cli-buildx
WORKDIR /dagr
COPY engine/dagr.bootstrap.json package.json
RUN npm install --no-audit --no-fund
COPY engine/dagr.bootstrap-tsconfig.json tsconfig.json
COPY engine/src src
RUN ./node_modules/.bin/tsc --project tsconfig.json
ENV REPO_ROOT=/repo
ENTRYPOINT ["node", "--experimental-vm-modules", "/dagr/build/index.js"]
