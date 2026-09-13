import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadTypeScript } from './dagr.typescript-loader.js'

const ts = await loadTypeScript()

const versions = {
  '@biomejs/biome': '2',
  '@cloudflare/workers-types': '4',
  '@eslint/js': '9',
  '@tailwindcss/vite': '4',
  '@tsconfig/strictest': '2',
  '@typescript-eslint/eslint-plugin': '8',
  '@typescript-eslint/parser': '8',
  '@types/node': '22',
  '@types/react': '19',
  '@types/react-dom': '19',
  '@vitejs/plugin-react': '4',
  'class-variance-authority': '0.7',
  clsx: '2',
  eslint: '9',
  'eslint-plugin-prettier': '5',
  jsdom: '30',
  prettier: '3',
  react: '19',
  'react-dom': '19',
  'react-router-dom': '7',
  'tailwind-merge': '3',
  tailwindcss: '4',
  typedoc: '0.28',
  typescript: '6',
  vite: '5',
  vitest: '3',
  wrangler: '4',
}

const decodeWritten = (steps, path) => {
  const step = steps.find(candidate => candidate.RUN?.endsWith(`> /repo/${path}`))
  assert.ok(step, `${path} was not written`)
  return JSON.parse(Buffer.from(step.RUN.match(/^echo "([^"]+)"/)[1], 'base64').toString('utf8'))
}

const runTarget = (index, facet, name, extra = {}) => {
  const target = index[facet][name]
  const images = Object.fromEntries(target.deps.map(dependency => [dependency, `${dependency}-image`]))
  return target.run({ images, ...extra })
}

const nodeLibrary = (...features) => ts.default([
  ts.typescript({ base: '//base:ci:image', versions }),
  ts.pnpm(),
  ts.library({ runtime: 'node' }),
  ...features,
])

describe('recipe architecture', () => {
  it('builds recipes from the generic init/run/graph builder', () => {
    const base = ts.rdk.graph({
      '/calculation/doubled': ts.rdk.derive(
        { input: ts.rdk.one('/calculation/input') },
        ({ input }) => input * 2,
      ),
    })
    const calculation = ts.builder(
      value => ts.rdk.graph({ '/calculation/input': ts.rdk.value(value) }),
      graph => graph.compile(['/calculation/doubled'])['/calculation/doubled'],
      base,
    )

    assert.equal(calculation(3), 6)
    assert.equal(calculation.graph, base)
    assert.equal(calculation.with(ts.rdk.graph({
      '/calculation/doubled': ts.rdk.derive(
        { input: ts.rdk.one('/calculation/input') },
        ({ input }) => input * 3,
      ),
    }))(3), 9)
    assert.equal(calculation(3), 6)
  })

  it('keeps canonical feature state separate from structural adapters and exact capabilities', () => {
    const built = nodeLibrary(ts.vitest(), ts.eslint(), ts.typedoc(), ts.hoister())
    const graph = built.graph

    assert.deepEqual(graph.bindingOf('/source/directory').inputs, {})
    assert.deepEqual(Object.keys(graph.bindingOf('/output/layout').inputs), [
      'product', 'directory', 'entry',
    ])
    assert.equal(graph.bindingOf('/output/layout').inputs.product.path, '/product/kind')
    assert.deepEqual(graph.bindingOf('/typescript/package-json').inputs.dependencies.selectors, [
      '/**/package-json/dependencies',
    ])
    assert.equal(
      graph.bindingOf('/typescript/package-json/hoisted').inputs.value.path,
      '/typescript/package-json',
    )
    assert.deepEqual(graph.bindingOf('/vitest/tooling').inputs, {})
    assert.equal(
      graph.bindingOf('/vitest/package-json/dependencies').inputs.tooling.path,
      '/vitest/tooling',
    )
    assert.deepEqual(graph.bindingOf('/vitest/tester').inputs.$files.selectors, [
      '/typescript/tsconfig', '/vitest/config',
    ])
    assert.deepEqual(graph.bindingOf('/typescript/compiler').inputs.$files.selectors, [
      '/typescript/tsconfig',
    ])
    assert.equal(graph.bindingOf('/typescript/tester').inputs.value.path, '/vitest/tester')
    assert.equal(graph.bindingOf('/target/ci/test').inputs.command.path, '/typescript/tester')
    assert.deepEqual(graph.bindingOf('/target/ci/test').inputs.files.selectors, [
      '/typescript/package-json',
      '/package-manager/config',
    ])
    assert.equal(
      graph.bindingOf('/target/ci/test').inputs.files.selectors.some(path => path.includes('*')),
      false,
    )
    assert.equal(graph.bindingOf('/typescript/package-json/materialized'), undefined)
    assert.deepEqual(graph.bindingOf('/target/dev/hoist').inputs.hoisted.selectors, [
      '/**/hoisted', '/**/hoisted/*',
    ])
    for (const path of ['/compiler', '/typechecker', '/tester', '/linter', '/bundler', '/documenter']) {
      assert.equal(graph.bindingOf(path), undefined)
    }
    assert.equal(graph.bindingOf('/workspace'), undefined)
    assert.equal(graph.bindingOf('/package/json'), undefined)
    assert.equal(graph.bindingOf('/facet/ci'), undefined)
    assert.deepEqual([...graph.keys()].filter(path => (
      path.startsWith('/file/')
      || path.startsWith('/requirement/')
      || path.startsWith('/command/')
    )), [])
  })

  it('projects feature-owned tooling into open consumer protocols', () => {
    const graph = ts.rdk.graph({
      '/first/tooling': ts.tooling({
        for: ['test'],
        packages: ['shared', 'first'],
        types: ['first'],
        builds: ['shared', 'first'],
      }),
      '/first/package-json/dependencies': ts.packageJsonDependencies('/first/tooling'),
      '/first/tsconfig/types': ts.tsconfigTypes('/first/tooling'),
      '/first/package-manager/builds': ts.packageManagerBuilds('/first/tooling'),
      '/second/tooling': ts.tooling({
        for: ['build', 'test'],
        packages: ['shared', 'second'],
        types: ['second'],
        builds: ['shared', 'second'],
      }),
      '/second/package-json/dependencies': ts.packageJsonDependencies('/second/tooling'),
      '/second/tsconfig/types': ts.tsconfigTypes('/second/tooling'),
      '/second/package-manager/builds': ts.packageManagerBuilds('/second/tooling'),
    })
    const selected = (compiled, suffix) => Object.fromEntries(
      Object.entries(compiled).filter(([path]) => path.endsWith(suffix)),
    )
    const dependencies = selected(
      graph.compile(['/**/package-json/dependencies']),
      '/package-json/dependencies',
    )
    const types = selected(graph.compile(['/**/tsconfig/types']), '/tsconfig/types')
    const builds = selected(
      graph.compile(['/**/package-manager/builds']),
      '/package-manager/builds',
    )

    assert.deepEqual(ts.packagesFor(dependencies, { intent: 'test' }, {
      shared: '1', first: '2', second: '3',
    }), { shared: '1', first: '2', second: '3' })
    assert.deepEqual(ts.typesFor(types, { intent: 'test' }), ['first', 'second'])
    assert.deepEqual(ts.buildsFor(builds, 'test'), ['shared', 'first', 'second'])
    assert.deepEqual(ts.buildsFor(builds, 'build'), ['shared', 'second'])
    assert.deepEqual(ts.buildsFor(builds, 'lint'), [])
  })

  it('lets a required capability own its exact optional file set', () => {
    const seen = []
    const feature = ts.rdk.graph({
      '/test/message': ts.rdk.value('hello'),
      '/package-manager/exec': ts.rdk.value(invocation => `resolve ${invocation}`),
      '/test/generated': ts.file({ message: ts.rdk.one('/test/message') }, {
        for: ['test'],
        render(context, { message }) {
          seen.push({ intent: context.intent, facet: context.facet, host: context.host })
          return { RUN: `write ${message}` }
        },
      }),
      '/test/host-aware': ts.file({}, {
        for: ['test'],
        render: context => ({ CMD: ['done', context.host.arch] }),
      }),
      '/test/skipped': ts.file({}, {
        for: ['build'],
        render: () => ({ RUN: 'wrong intent' }),
      }),
      '/test/runner': ts.command({ message: ts.rdk.one('/test/message') }, {
        for: ['test'],
        files: ts.rdk.many(
          '/test/generated',
          '/test/host-aware',
          '/test/skipped',
          '/test/absent',
        ),
        run: ({ message }) => [
          { tool: `${message} suite` },
          { shell: 'echo done > /tmp/log' },
        ],
      }),
      '/runner': ts.adapter('/test/runner'),
      '/target/quality/inspect': ts.target({
        exec: ts.rdk.one('/package-manager/exec'),
        runner: ts.rdk.one('/runner'),
      }, {
        intent: 'test',
        render: (context, { exec, runner }) => ({
          deps: [],
          run: ({ host }) => ({
            FROM: 'scratch',
            steps: [
              ...context.files(runner.files, { host }),
              ...ts.runSteps(runner.invocations, exec),
            ],
            IGNORE: [],
          }),
        }),
      }),
    })

    const index = ts.default([feature])({ location: '//example' })
    const rendered = index.quality.inspect.run({ host: { os: 'linux', arch: 'arm64' } })

    // A tool invocation is resolved by the materializer; a shell one is passed through verbatim.
    assert.deepEqual(rendered.steps, [
      { RUN: 'write hello' },
      { CMD: ['done', 'arm64'] },
      { RUN: 'resolve hello suite' },
      { RUN: 'echo done > /tmp/log' },
    ])
    assert.deepEqual(seen, [{ intent: 'test', facet: 'quality', host: { os: 'linux', arch: 'arm64' } }])
    assert.throws(
      () => ts.sourceTarget({ files: ['/test/**'] }),
      /sourceTarget files must be exact semantic paths: \/test\/\*\*/,
    )
    assert.throws(
      () => ts.command({}, {
        for: ['test'],
        files: ts.rdk.many('/test/**'),
        run: () => ({ tool: 'test' }),
      }),
      /command contribution files must use many\(\) with exact semantic paths/,
    )
  })

  it('derives target identity from paths and resolves ownership collisions by normal replacement', () => {
    const contribution = (facet, owner) => ts.rdk.graph({
      [`/target/${facet}/same`]: ts.target({}, {
        render: () => ({
          deps: [],
          run: () => ({ FROM: owner, steps: [], IGNORE: [] }),
        }),
      }),
    })

    const twoFacets = ts.default([contribution('ci', 'ci'), contribution('dev', 'dev')])({
      location: '//example',
    })
    assert.equal(twoFacets.ci.same.name, 'same')
    assert.equal(twoFacets.dev.same.name, 'same')

    const replaced = ts.default([
      contribution('ci', 'first'),
      contribution('ci', 'second'),
    ])({ location: '//example' })
    assert.equal(replaced.ci.same.run().FROM, 'second')
  })

  it('materializes one invocation as both a container step and a manager script', () => {
    const withManager = manager => ts.default([
      ts.typescript({ base: '//base:ci:image', versions }), manager,
      ts.library({ runtime: 'node' }), ts.vitest(), ts.eslint(),
    ])({ location: '//packages/example' })

    for (const [manager, install, exec] of [
      [ts.pnpm(), 'pnpm install --prod=false', 'pnpm exec tsc'],
      [ts.npm(), 'npm install --include=dev', 'npm exec -- tsc'],
    ]) {
      const index = withManager(manager)
      const build = runTarget(index, 'ci', 'build')

      // The container resolves the tool through the manager and installs first.
      assert.deepEqual(
        build.steps.filter(step => step.RUN && !step.RUN.startsWith('echo')).map(step => step.RUN),
        [install, exec],
      )
      // The very same declarations, as scripts, where no resolution prefix belongs.
      assert.deepEqual(decodeWritten(build.steps, 'package.json').scripts, {
        typecheck: 'tsc --noEmit',
        test: 'vitest run',
        lint: 'eslint .',
        build: 'tsc',
      })
      // A published manifest carries no scripts, like it carries no devDependencies.
      assert.equal('scripts' in decodeWritten(runTarget(index, 'publish', 'pack').steps, 'package.json'), false)
    }

    // Replacing the exact capability also replaces the package.json script that projects it.
    const extended = ts.default([
      ts.typescript({ base: '//base:ci:image', versions }), ts.pnpm(), ts.library({ runtime: 'node' }),
      ts.rdk.graph({
        '/verified/compiler': ts.command({}, {
          for: ['build'],
          run: () => [{ tool: 'tsc' }, { shell: 'verify' }],
        }),
        '/typescript/compiler': ts.adapter('/verified/compiler'),
      }),
    ])({ location: '//packages/example' })
    const build = runTarget(extended, 'ci', 'build')
    assert.deepEqual(decodeWritten(build.steps, 'package.json').scripts.build, 'tsc && verify')
    assert.deepEqual(build.steps.slice(-2).map(step => step.RUN), ['pnpm exec tsc', 'verify'])
  })

  it('configures rollup from facts the recipe already has', () => {
    const rollupVersions = {
      ...versions,
      '@rollup/plugin-commonjs': '29',
      '@rollup/plugin-node-resolve': '16',
      rollup: '4',
    }
    const index = ts.default([
      ts.typescript({
        base: '//base:ci:image',
        versions: rollupVersions,
        outputDirectory: 'build',
      }),
      ts.pnpm(),
      ts.library({ runtime: 'node' }),
      ts.rollup(),
    ])({ location: '//packages/example' })

    const bundle = runTarget(index, 'ci', 'bundle')
    assert.deepEqual(index.ci.bundle.deps, ['build'])
    assert.equal(bundle.EXPORT['/repo/dist/example.js'], 'dist/example.js')
    assert.equal(bundle.steps.at(-1).RUN, 'pnpm exec rollup --config rollup.config.js')

    // The compile output is the bundler input, and the package slug names the bundle.
    const config = Buffer.from(
      bundle.steps.find(step => step.RUN?.endsWith('> /repo/rollup.config.js')).RUN.match(/^echo "([^"]+)"/)[1],
      'base64',
    ).toString()
    assert.match(config, /input: "build\/index\.js"/)
    assert.match(config, /file: "dist\/example\.js"/)
    assert.match(config, /handler\('error', log\)/)

    // Nothing rollup contributes leaks into the compile target that feeds it.
    const build = runTarget(index, 'ci', 'build')
    assert.equal(build.steps.some(step => step.RUN?.includes('rollup')), false)

    assert.doesNotMatch(
      Buffer.from(
        runTarget(ts.default([
          ts.typescript({ base: '//base:ci:image', versions: rollupVersions, outputDirectory: 'build' }),
          ts.pnpm(), ts.library({ runtime: 'node' }), ts.rollup({ strict: false }),
        ])({ location: '//packages/example' }), 'ci', 'bundle')
          .steps.find(step => step.RUN?.endsWith('> /repo/rollup.config.js')).RUN.match(/^echo "([^"]+)"/)[1],
        'base64',
      ).toString(),
      /onLog/,
    )

    // A web product builds, but vite already bundles it, so there is no single entry to feed rollup.
    assert.throws(
      () => runTarget(ts.default([
        ts.typescript({ base: '//base:ci:image', versions: rollupVersions }),
        ts.pnpm(), ts.viteReact(), ts.rollup(),
      ])({ location: '//web' }), 'ci', 'bundle'),
      /rollup\(\) needs a product that emits JavaScript/,
    )
  })

  it('rejects a sibling dependency no contribution owns, qualified or bare', () => {
    const dependent = (facet, dependency) => ts.rdk.graph({
      [`/target/${facet}/ship`]: ts.target({}, {
        intent: 'publish',
        render: () => ({
          deps: [dependency],
          run: () => ({ FROM: 'scratch', steps: [], IGNORE: [] }),
        }),
      }),
    })

    // A bare name resolves against the depending target's own facet.
    assert.throws(
      () => ts.default([dependent('publish', 'build')])({ location: '//example' }),
      /target "publish:ship" depends on "build", which no contribution owns/,
    )
    assert.throws(
      () => ts.default([dependent('publish', 'ci:build')])({ location: '//example' }),
      /target "publish:ship" depends on "ci:build", which no contribution owns/,
    )

    // The library already owns ci:build, so both forms resolve against it.
    assert.deepEqual(
      nodeLibrary().with(dependent('publish', 'ci:build'))({ location: '//example' })
        .publish.ship.deps,
      ['ci:build'],
    )
    assert.deepEqual(
      nodeLibrary().with(dependent('ci', 'build'))({ location: '//example' }).ci.ship.deps,
      ['build'],
    )

    // Another package's target cannot be checked here.
    assert.deepEqual(
      ts.default([dependent('ci', '//packages/core:ci:pack')])({ location: '//example' })
        .ci.ship.deps,
      ['//packages/core:ci:pack'],
    )
  })

  it('rejects rendered steps that are not steps, and packages with no catalog version', () => {
    const build = contribution => ts.default([contribution, ts.rdk.graph({
      '/target/ci/build': ts.target({ files: ts.rdk.many('/invalid/file') }, {
        intent: 'build',
        render: (context, { files }) => ({
          deps: [],
          run: () => ({ FROM: 'scratch', steps: context.files(files), IGNORE: [] }),
        }),
      }),
    })])({ location: '//example' }).ci.build.run({ images: {} })

    assert.throws(
      () => build(ts.rdk.graph({
        '/invalid/file': ts.file({}, { for: ['build'], render: () => undefined }),
      })),
      /file contribution render must return a Dagr step or an array of steps/,
    )
    assert.throws(
      () => build(ts.rdk.graph({
        '/invalid/file': ts.file({}, { for: ['build'], render: () => [false] }),
      })),
      /file contribution render must return a Dagr step or an array of steps/,
    )
    assert.throws(
      () => ts.rdk.graph({
        '/invalid/command': ts.command({}, { for: ['build'], run: () => ({ RUN: 'a step' }) }),
      }).compile(['/invalid/command']),
      /an invocation needs exactly one of tool or shell, naming what to run/,
    )
    assert.throws(
      () => ts.rdk.graph({
        '/invalid/command': ts.command({}, {
          for: ['build'], run: () => ({ tool: 'a', shell: 'b' }),
        }),
      }).compile(['/invalid/command']),
      /an invocation needs exactly one of tool or shell, naming what to run/,
    )
    assert.throws(
      () => ts.rdk.graph({
        '/invalid/command': ts.command({}, { run: () => ({ tool: 'a' }) }),
      }),
      /command contribution needs for, the intents whose run it is/,
    )
    assert.throws(
      () => ts.default([
        ts.typescript({ base: '//base:ci:image', versions: {} }), ts.npm(), ts.library(),
      ])({ location: '//example' }).ci.typecheck.run({ images: { base: 'base-image' } }),
      /No version configured for package "@tsconfig\/strictest"/,
    )
  })

  it('renders coherent files from one context without intent-aware graph values', () => {
    const index = nodeLibrary(
      ts.prettier({ semi: true, trailingComma: 'all' }),
      ts.vitest({ globals: true }),
      ts.eslint({ prettier: true }),
      ts.typedoc({ title: 'Example' }),
    )({ location: '//packages/example', version: '1.2.3' })

    const build = runTarget(index, 'ci', 'build')
    const test = runTarget(index, 'ci', 'test')
    const lint = runTarget(index, 'ci', 'lint')
    const docs = runTarget(index, 'ci', 'docs')

    const manifest = decodeWritten(build.steps, 'package.json')
    const config = decodeWritten(build.steps, 'tsconfig.json')
    assert.equal(manifest.main, './src/index.ts')
    assert.equal(manifest.devDependencies.typescript, '6')
    assert.equal(manifest.devDependencies['@types/node'], '22')
    assert.equal(config.compilerOptions.outDir, 'dist')
    assert.equal(config.compilerOptions.noEmit, false)
    assert.deepEqual(config.exclude, ['src/**/*.test.ts', 'src/**/*.spec.ts'])
    assert.equal(build.steps.at(-2).RUN, 'pnpm install --prod=false')
    assert.equal(build.steps.at(-1).RUN, 'pnpm exec tsc')

    assert.deepEqual(decodeWritten(test.steps, 'tsconfig.json').compilerOptions.types.sort(), [
      'node', 'vitest/globals',
    ])
    assert.ok(lint.steps.some(step => step.RUN?.endsWith('> /repo/.prettierrc.json')))
    assert.ok(lint.steps.some(step => step.RUN?.endsWith('> /repo/eslint.config.mjs')))
    assert.equal(lint.steps.at(-1).RUN, 'pnpm exec eslint .')
    assert.deepEqual(decodeWritten(docs.steps, 'typedoc.json').exclude, [
      'src/**/*.test.ts', 'src/**/*.spec.ts',
    ])
  })

  it('projects a replaced ordinary source node into files and targets', () => {
    const custom = nodeLibrary(ts.eslint(), ts.typedoc()).with(ts.rdk.graph({
      '/source/directory': ts.rdk.value('source'),
    }))
    const index = custom({ location: '//packages/example' })

    const build = runTarget(index, 'ci', 'build')
    const lint = runTarget(index, 'ci', 'lint')
    const docs = runTarget(index, 'ci', 'docs')
    assert.deepEqual(build.steps[0], { COPY: { src: 'source', dest: '/repo/source' } })
    assert.equal(decodeWritten(build.steps, 'tsconfig.json').compilerOptions.rootDir, 'source')
    assert.match(Buffer.from(lint.steps.find(step => step.RUN?.endsWith('eslint.config.mjs')).RUN.match(/^echo "([^"]+)"/)[1], 'base64').toString(), /source\/\*\*\/\*\.ts/)
    assert.deepEqual(decodeWritten(docs.steps, 'typedoc.json').entryPoints, ['source/index.ts'])
  })

  it('selects one replaceable TypeScript compiler through an exact binding', () => {
    const extension = ts.rdk.graph({
      '/verified/compiler': ts.command({}, {
        for: ['build'], run: () => [{ tool: 'tsc' }, { shell: 'verify build' }],
      }),
      '/typescript/compiler': ts.adapter('/verified/compiler'),
    })
    const index = nodeLibrary().with(extension)({ location: '//packages/example' })
    const build = runTarget(index, 'ci', 'build')

    assert.equal(build.steps.at(-2).RUN, 'pnpm exec tsc')
    assert.equal(build.steps.at(-1).RUN, 'verify build')
    assert.equal(decodeWritten(build.steps, 'package.json').scripts.build, 'tsc && verify build')
  })

  it('derives worker and Vite outputs from their product facts', () => {
    const worker = ts.default([
      ts.typescript({ base: '//base:ci:image', versions }), ts.npm(), ts.cloudflareWorker(),
    ])({ location: '//worker' })
    const workerTypecheck = runTarget(worker, 'ci', 'typecheck')
    assert.deepEqual(decodeWritten(workerTypecheck.steps, 'tsconfig.json').compilerOptions.types, [
      '@cloudflare/workers-types',
    ])
    assert.deepEqual(decodeWritten(workerTypecheck.steps, 'package.json').imports, { '#/*': './src/*' })

    const web = ts.default([
      ts.typescript({ base: '//base:ci:image', versions }), ts.yarn(), ts.viteReact(), ts.vitest({ environment: 'jsdom' }),
    ])({ location: '//web' })
    const test = runTarget(web, 'ci', 'test')
    const build = runTarget(web, 'ci', 'build')
    assert.deepEqual(decodeWritten(build.steps, 'tsconfig.json').compilerOptions.lib, [
      'ES2020', 'DOM', 'DOM.Iterable',
    ])
    assert.equal(decodeWritten(build.steps, 'package.json').dependencies.react, '19')
    assert.ok(build.steps.some(step => step.COPY?.src === 'index.html'))
    assert.match(Buffer.from(test.steps.find(step => step.RUN?.endsWith('vitest.config.ts')).RUN.match(/^echo "([^"]+)"/)[1], 'base64').toString(), /mergeConfig\(viteConfig/)
  })
})
