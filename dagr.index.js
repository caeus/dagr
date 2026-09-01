const IGNORE = ['node_modules', 'build', 'dist', '.git']

const install = '//:ci:install'
const build = '//:ci:build'
const bundlecheck = '//:ci:bundlecheck'

const PACKAGE_JSON = {
  name: '@caeus/dagr',
  version: '0.0.0',
  private: true,
  type: 'module',
  imports: { '#*': './build/*' },
  devDependencies: {
    '@rollup/plugin-commonjs': '29.0.3',
    '@rollup/plugin-node-resolve': '16.0.3',
    '@tsconfig/strictest': '2.0.8',
    '@types/node': '26.2.0',
    rollup: '4.63.1',
    tsx: '4.23.7',
    typescript: '6.0.3',
  },
  dependencies: {
    '@caeus/wyr': '0.0.0-rc1',
    '@optique/core': '1.2.0',
    '@optique/run': '1.2.0',
    'smol-toml': '1.7.0',
    yaml: '2.8.3',
    zod: '4.4.3',
  },
}

const PNPM_WORKSPACE = `allowBuilds:\n  esbuild: true\n`

const ROLLUP_CONFIG = `import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import { builtinModules } from 'node:module'

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => \`node:\${name}\`)
])

export default {
  input: 'build/index.js',
  external: (id) => builtins.has(id),
  plugins: [nodeResolve({ preferBuiltins: true }), commonjs()],
  onLog(level, log, handler) {
    if (log.code === 'CIRCULAR_DEPENDENCY') return
    if (level === 'warn') handler('error', log)
    else handler(level, log)
  },
  output: {
    file: 'dist/dagr.js',
    format: 'esm'
  }
}
`

function writeText(path, content) {
  return { RUN: `echo '${Buffer.from(content).toString('base64')}' | base64 -d > ${path}` }
}

function writeJson(path, value) {
  return writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

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
          writeJson('/repo/package.json', PACKAGE_JSON),
          { COPY: { src: 'pnpm-lock.yaml', dest: '/repo/pnpm-lock.yaml' } },
          writeText('/repo/pnpm-workspace.yaml', PNPM_WORKSPACE),
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
          writeText('/repo/rollup.config.js', ROLLUP_CONFIG),
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
      deps: [bundlecheck],
      run: ({ images }) => ({
        FROM: 'node:22-alpine',
        steps: [
          { RUN: 'apk add --no-cache docker-cli docker-cli-buildx' },
          { WORKDIR: '/dagr' },
          { COPY: { from: images[bundlecheck], src: '/repo/dist/dagr.js', dest: '/dagr/dagr.js' } },
          { ENV: { REPO_ROOT: '/repo' } },
          { ENTRYPOINT: ['node', '--experimental-vm-modules', '/dagr/dagr.js'] },
        ],
        IGNORE: [],
      }),
    },
  },
}
