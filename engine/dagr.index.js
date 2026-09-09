import recipe, {
  command,
  library,
  pnpm,
  rdk,
  requirement,
  rollup,
  runSteps,
  target,
  typescript,
} from '//engine/recipes/typescript//dagr.recipe.js'

const TEST_RUN = "node --experimental-vm-modules --enable-source-maps --import tsx/esm"
  + " --test --test-reporter=spec 'src/**/*.test.ts'"

const SMOKE_RUN = 'mkdir -p /tmp/dagr-smoke/packages'
  + ' && HOST_OS=linux HOST_ARCH=x64 HOST_LIBC=musl REPO_ROOT=/tmp/dagr-smoke'
  + ' node --experimental-vm-modules dist/dagr.js list > /dev/null'

const versions = {
  '@caeus/wyr': '0.0.0-rc1',
  '@optique/core': '1.2.0',
  '@optique/run': '1.2.0',
  'smol-toml': '1.7.0',
  tsx: '4.23.7',
  yaml: '2.8.3',
  zod: '4.4.3',
}

const dagr = rdk.graph({
  name: rdk.value('@caeus/dagr'),

  // A bundled CLI publishes one JavaScript file, so type declarations are dead weight.
  emitDeclarations: rdk.value(false),

  importAlias: rdk.derive(['sourceDirectory', 'outputDirectory'], (source, output) => ({
    specifier: '#*',
    sourcePath: `./${source}/*`,
    runtimePath: `./${output}/*`,
  })),

  dagrRequirements: requirement({
    packages: ['tsx'],
    allowBuilds: ['esbuild'],
  }),

  nodePnpmTarget: target([], {
    name: 'node-pnpm',
    facet: 'ci',
    render: () => ({
      deps: [],
      run: () => ({
        FROM: 'node:22-alpine',
        steps: [
          { RUN: 'corepack enable && corepack prepare pnpm@11.20.0 --activate' },
          { WORKDIR: '/repo' },
        ],
        IGNORE: [],
      }),
    }),
  }),

  // Declared as an invocation so `pnpm test` on a host runs what CI runs.
  testCommand: command([], {
    for: ['test'],
    run: () => ({ shell: TEST_RUN }),
  }),

  testTarget: target(['ignore', 'exec'], {
    name: 'test',
    facet: 'ci',
    render: (context, ignore, exec) => ({
      deps: ['ci:build'],
      run: ({ images }) => ({
        FROM: images['ci:build'],
        steps: runSteps(context.invocations(), exec),
        IGNORE: ignore,
      }),
    }),
  }),

  bundlecheckTarget: target(['ignore'], {
    name: 'bundlecheck',
    facet: 'ci',
    render: (_context, ignore) => ({
      deps: ['ci:bundle'],
      run: ({ images }) => ({
        FROM: images['ci:bundle'],
        steps: [{ RUN: SMOKE_RUN }],
        IGNORE: ignore,
      }),
    }),
  }),

  imageTarget: target([], {
    name: 'image',
    facet: 'ci',
    render: () => ({
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
  }),
})

const engine = recipe([
  typescript({
    base: '//engine:ci:node-pnpm',
    scope: 'internal',
    versions,
    outputDirectory: 'build',
    ignore: ['.git', '.dagr', 'node_modules', 'build', 'dist', 'docs', 'coverage'],
  }),
  pnpm(),
  library({ runtime: 'node', sourceMaps: true }),
  rollup(),
  dagr,
])

export default engine({
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
