FROM node:22-alpine

RUN apk add --no-cache docker-cli docker-cli-buildx && corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /dagr

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY src/ ./src/
COPY tsconfig.json tsconfig.build.json ./

RUN pnpm exec tsc -p tsconfig.build.json

# A broken #* import map or missing module only surfaces when the compiled entrypoint loads,
# which is too late if it happens on a user's first invocation. Fail the image build instead.
RUN mkdir -p /tmp/smoke/packages && \
    HOST_OS=linux HOST_ARCH=x64 HOST_LIBC=musl REPO_ROOT=/tmp/smoke \
    node --experimental-vm-modules build/index.js list > /dev/null && \
    rm -rf /tmp/smoke

ENV REPO_ROOT=/repo

ENTRYPOINT ["node", "--experimental-vm-modules", "build/index.js"]
