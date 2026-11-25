import {
  typescript, library, pnpm, npm, yarn, vitest, eslint, prettier,
  rollup, typedoc, hoister, cloudflareWorker, viteReact, value,
} from '//recipes/tests/typescript//dagr.recipe.js'

// These are ordinary feature graphs. The assertion node consumes actual generated
// image/path values; there is no recipe evaluator or fake image map in the harness.
export const recipeGraphs = () => ({
  ...typescript('app', {
    packageName: '@internal/app',
    deps: [{ name: '@internal/lib', target: '//recipes:/lib/pack', at: 'prod' }],
  }),
  ...library('app', { runtime: 'node' }),
  ...pnpm('app'),
  ...vitest('app'),
  ...eslint('app', { prettier: true }),
  ...prettier('app'),
  ...rollup('app'),
  ...typedoc('app'),
  ...hoister('app'),
  '/app/node-base': value('node:22-alpine'),
  ...typescript('lib'),
  ...library('lib'),
  ...npm('lib'),
  '/lib/node-base': value('node:22-alpine'),
  ...typescript('worker'),
  ...cloudflareWorker('worker'),
  ...yarn('worker'),
  '/worker/node-base': value('node:22-alpine'),
  ...typescript('web'),
  ...viteReact('web'),
  ...vitest('web', { environment: 'jsdom' }),
  ...pnpm('web'),
  '/web/node-base': value('node:22-alpine'),
})

export const generatedFileTests = {
  deps: {
    appManifest: '/app/file/build/package.json',
    packManifest: '/app/file/pack/package.json',
    appTsconfig: '/app/file/build/tsconfig.json',
    appTest: '/app/file/test/vitest.config.ts',
    appLint: '/app/file/lint/eslint.config.mjs',
    appPrettier: '/app/file/lint/prettierrc.json',
    appPnpm: '/app/file/test/package-manager/pnpm-workspace.yaml',
    appRollup: '/app/file/bundle/rollup.config.js',
    appDocs: '/app/file/docs/typedoc.json',
    workerManifest: '/worker/file/typecheck/package.json',
    workerTsconfig: '/worker/file/typecheck/tsconfig.json',
    workerYarn: '/worker/file/dev/package-manager/yarnrc.yml',
    webManifest: '/web/file/build/package.json',
    webVite: '/web/file/build/vite.config.ts',
    webTest: '/web/file/test/vitest.config.ts',
  },
  run: files => ({
    build: {
      FROM: 'node:22-alpine',
      steps: [
        { WORKDIR: '/checks' },
        ...Object.entries(files).map(([name, file]) => ({
          COPY: { from: file.image, src: file.path, dest: '/checks/' + name },
        })),
        { COPY: { src: 'tests/assert-generated.mjs', dest: '/checks/assert-generated.mjs' } },
        { RUN: 'node /checks/assert-generated.mjs' },
      ],
      IGNORE: ['.git', 'node_modules'],
    },
  }),
}
