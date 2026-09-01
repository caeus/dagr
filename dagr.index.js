const IGNORE = ['node_modules', 'build', 'dist', '.git']

const install = '//:ci:install'
const build = '//:ci:build'

const sourceSteps = [
  { COPY: { src: 'src', dest: '/repo/src' } },
  { COPY: { src: 'tsconfig.json', dest: '/repo/tsconfig.json' } },
  { COPY: { src: 'tsconfig.build.json', dest: '/repo/tsconfig.build.json' } },
]

export default {
  ci: {
    install: {
      deps: [],
      run: () => ({
        FROM: 'node:22-alpine',
        steps: [
          { RUN: 'corepack enable && corepack prepare pnpm@latest --activate' },
          { WORKDIR: '/repo' },
          { COPY: { src: 'package.json', dest: '/repo/package.json' } },
          { COPY: { src: 'pnpm-lock.yaml', dest: '/repo/pnpm-lock.yaml' } },
          { COPY: { src: 'pnpm-workspace.yaml', dest: '/repo/pnpm-workspace.yaml' } },
          { RUN: 'pnpm install --frozen-lockfile' },
        ],
        IGNORE,
      }),
    },

    typecheck: {
      deps: [install],
      run: ({ images }) => ({
        FROM: images[install],
        steps: [
          ...sourceSteps,
          { RUN: 'pnpm exec tsc --noEmit' },
        ],
        IGNORE,
      }),
    },

    build: {
      deps: [install],
      run: ({ images }) => ({
        FROM: images[install],
        steps: [
          ...sourceSteps,
          { COPY: { src: 'rollup.config.js', dest: '/repo/rollup.config.js' } },
          { RUN: 'pnpm exec tsc -p tsconfig.build.json' },
          { RUN: 'mkdir -p dist && pnpm exec rollup --config rollup.config.js' },
        ],
        IGNORE,
        EXPORT: { '/repo/dist/dagr.js': 'dist/dagr.js' },
      }),
    },

    test: {
      deps: [build],
      run: ({ images }) => ({
        FROM: images[build],
        steps: [
          { RUN: "node --experimental-vm-modules --enable-source-maps --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'" },
        ],
        IGNORE,
      }),
    },

    bundlecheck: {
      deps: [build],
      run: ({ images }) => ({
        FROM: images[build],
        steps: [
          { RUN: 'mkdir -p /tmp/dagr-smoke/packages && HOST_OS=linux HOST_ARCH=x64 HOST_LIBC=musl REPO_ROOT=/tmp/dagr-smoke node --experimental-vm-modules dist/dagr.js list > /dev/null' },
        ],
        IGNORE,
      }),
    },

    image: {
      deps: [build],
      run: ({ images }) => ({
        FROM: 'node:22-alpine',
        steps: [
          { RUN: 'apk add --no-cache docker-cli docker-cli-buildx' },
          { WORKDIR: '/dagr' },
          { COPY: { from: images[build], src: '/repo/dist/dagr.js', dest: '/dagr/dagr.js' } },
          { ENV: { REPO_ROOT: '/repo' } },
          { ENTRYPOINT: ['node', '--experimental-vm-modules', '/dagr/dagr.js'] },
        ],
        IGNORE: [],
      }),
    },
  },
}
