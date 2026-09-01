import typescript, { ciFacet, di, library, target } from '//stacks/ts//dagr.stack.js'

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

const versions = {
  '@caeus/wyr': '0.0.0-rc1',
  '@optique/core': '1.2.0',
  '@optique/run': '1.2.0',
  '@rollup/plugin-commonjs': '29.0.3',
  '@rollup/plugin-node-resolve': '16.0.3',
  rollup: '4.63.1',
  'smol-toml': '1.7.0',
  tsx: '4.23.7',
  yaml: '2.8.3',
  zod: '4.4.3',
}

const dagr = di.module({
  name: di.toValue('@caeus/dagr'),

  nodePnpmTarget: di.toValue(target('node-pnpm', {
    deps: [],
    run: () => ({
      FROM: 'node:22-alpine',
      steps: [
        { RUN: 'corepack enable && corepack prepare pnpm@11.20.0 --activate' },
        { WORKDIR: '/repo' },
      ],
      IGNORE: [],
    }),
  }), [ciFacet.targets]),

  sourceAlias: di.toFun(
    ['sourceDirectory'],
    directory => ({ specifier: '#*', sourcePath: `./${directory}/*` }),
  ),
  'packageJson.imports': di.toFun(
    ['outputDirectory'],
    directory => ({ '#*': `./${directory}/*` }),
  ),
  'tsconfig.compilerOptions.declaration': di.toValue(false),

  dagrToolPackages: di.toValue([
    '@rollup/plugin-commonjs',
    '@rollup/plugin-node-resolve',
    'rollup',
    'tsx',
  ], ['toolPackages']),
  dagrAllowBuilds: di.toValue(['esbuild'], ['allowBuilds']),

  testTarget: di.toFun(
    ['libraryBuildTarget', '#dagrRuntime'],
    (_build, runtime) => target('test', {
      deps: ['ci:build'],
      run: ({ images }) => ({
        FROM: images['ci:build'],
        steps: [
          { RUN: "node --experimental-vm-modules --enable-source-maps --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'" },
        ],
        IGNORE: runtime.ignore,
      }),
    }),
    [ciFacet.targets],
  ),

  bundleTarget: di.toFun(
    ['libraryBuildTarget', '#dagrRuntime'],
    (_build, runtime) => target('bundle', {
      deps: ['ci:build'],
      run: ({ images }) => ({
        FROM: images['ci:build'],
        steps: [
          runtime.writeText('/repo/rollup.config.js', ROLLUP_CONFIG),
          { RUN: 'mkdir -p dist && pnpm exec rollup --config rollup.config.js' },
        ],
        IGNORE: runtime.ignore,
        EXPORT: { '/repo/dist/dagr.js': 'dist/dagr.js' },
      }),
    }),
    [ciFacet.targets],
  ),

  bundlecheckTarget: di.toFun(
    ['#dagrRuntime'],
    runtime => target('bundlecheck', {
      deps: ['ci:bundle'],
      run: ({ images }) => ({
        FROM: images['ci:bundle'],
        steps: [
          { RUN: 'mkdir -p /tmp/dagr-smoke/packages && HOST_OS=linux HOST_ARCH=x64 HOST_LIBC=musl REPO_ROOT=/tmp/dagr-smoke node --experimental-vm-modules dist/dagr.js list > /dev/null' },
        ],
        IGNORE: runtime.ignore,
      }),
    }),
    [ciFacet.targets],
  ),

  imageTarget: di.toFun(
    [],
    () => target('image', {
      deps: ['ci:bundlecheck'],
      run: ({ images }) => ({
        FROM: 'node:22-alpine',
        steps: [
          { RUN: 'apk add --no-cache docker-cli docker-cli-buildx' },
          { WORKDIR: '/dagr' },
          { COPY: { from: images['ci:bundlecheck'], src: '/repo/dist/dagr.js', dest: '/dagr/dagr.js' } },
          { ENV: { REPO_ROOT: '/repo' } },
          { ENTRYPOINT: ['node', '--experimental-vm-modules', '/dagr/dagr.js'] },
        ],
        IGNORE: [],
      }),
    }),
    [ciFacet.targets],
  ),
})

const stack = typescript({
  base: '//:ci:node-pnpm',
  scope: 'internal',
  versions,
  conventions: { outputDirectory: 'build' },
  ignore: ['.git', '.dagr', 'node_modules', 'build', 'dist', 'docs', 'coverage'],
})
  .with(library({ runtime: 'node', sourceMaps: true }))
  .with(dagr)

export default stack({
  location: import.meta.dagr.location,
  version: '0.0.0',
  deps: [
    { npm: '@caeus/wyr', at: 'prod' },
    { npm: '@optique/core', at: 'prod' },
    { npm: '@optique/run', at: 'prod' },
    { npm: 'smol-toml', at: 'prod' },
    { npm: 'yaml', at: 'prod' },
    { npm: 'zod', at: 'prod' },
  ],
})
