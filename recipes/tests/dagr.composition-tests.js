import recipe, {
  adapter,
  buildsFor,
  builder,
  cloudflareWorker,
  command,
  eslint,
  file,
  hoister,
  library,
  npm,
  packageJsonDependencies,
  packageManagerBuilds,
  packagesFor,
  pnpm,
  prettier,
  rdk,
  rollup,
  runSteps,
  sourceTarget,
  target,
  tooling,
  tsconfigTypes,
  typedoc,
  typescript,
  typesFor,
  viteReact,
  vitest,
  yarn,
} from '//recipes/tests/typescript//dagr.recipe.js'
import { suite } from '//recipes/tests/dagr.testing.js'

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

const decode = step => Buffer
  .from(step.RUN.match(/^echo "([^"]+)"/)[1], 'base64')
  .toString('utf8')

const writtenText = (steps, path) => {
  const step = steps.find(candidate => candidate.RUN?.endsWith(`> /repo/${path}`))
  if (step === undefined) throw new Error(`${path} was not written`)
  return decode(step)
}

const written = (steps, path) => JSON.parse(writtenText(steps, path))

const runTarget = (index, facet, name, extra = {}) => {
  const built = index[facet][name]
  const images = Object.fromEntries(built.deps.map(dependency => [dependency, `${dependency}-image`]))
  return built.run({ images, ...extra })
}

const nodeLibrary = (...features) => recipe([
  typescript({ base: '//base:ci:image', versions }),
  pnpm(),
  library({ runtime: 'node' }),
  ...features,
])

export default function compositionTests() {
  const { test, results } = suite('recipe architecture')

  test('builds recipes from the generic init/run/graph builder', assert => {
    const base = rdk.graph({
      '/calculation/doubled': rdk.derive(
        { input: rdk.one('/calculation/input') },
        ({ input }) => input * 2,
      ),
    })
    const calculation = builder(
      value => rdk.graph({ '/calculation/input': rdk.value(value) }),
      graph => graph.compile(['/calculation/doubled'])['/calculation/doubled'],
      base,
    )

    assert.equal(calculation(3), 6)
    assert.equal(calculation.graph, base)
    assert.equal(calculation.with(rdk.graph({
      '/calculation/doubled': rdk.derive(
        { input: rdk.one('/calculation/input') },
        ({ input }) => input * 3,
      ),
    }))(3), 9)
    assert.equal(calculation(3), 6)
  })

  test('keeps canonical feature state separate from structural adapters and exact capabilities', assert => {
    const graph = nodeLibrary(vitest(), eslint(), typedoc(), hoister()).graph

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
    assert.deepEqual(graph.bindingOf('/vitest/tester').inputs.files.selectors, [
      '/typescript/tsconfig', '/vitest/config',
    ])
    assert.deepEqual(graph.bindingOf('/typescript/compiler').inputs.files.selectors, [
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
      assert.equal(graph.bindingOf(path), undefined, `${path} is not a canonical binding`)
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

  test('projects feature-owned tooling into open consumer protocols', assert => {
    const graph = rdk.graph({
      '/first/tooling': tooling({
        for: ['test'],
        packages: ['shared', 'first'],
        types: ['first'],
        builds: ['shared', 'first'],
      }),
      '/first/package-json/dependencies': packageJsonDependencies('/first/tooling'),
      '/first/tsconfig/types': tsconfigTypes('/first/tooling'),
      '/first/package-manager/builds': packageManagerBuilds('/first/tooling'),
      '/second/tooling': tooling({
        for: ['build', 'test'],
        packages: ['shared', 'second'],
        types: ['second'],
        builds: ['shared', 'second'],
      }),
      '/second/package-json/dependencies': packageJsonDependencies('/second/tooling'),
      '/second/tsconfig/types': tsconfigTypes('/second/tooling'),
      '/second/package-manager/builds': packageManagerBuilds('/second/tooling'),
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

    assert.deepEqual(packagesFor(dependencies, { intent: 'test' }, {
      shared: '1', first: '2', second: '3',
    }), { shared: '1', first: '2', second: '3' })
    assert.deepEqual(typesFor(types, { intent: 'test' }), ['first', 'second'])
    assert.deepEqual(buildsFor(builds, 'test'), ['shared', 'first', 'second'])
    assert.deepEqual(buildsFor(builds, 'build'), ['shared', 'second'])
    assert.deepEqual(buildsFor(builds, 'lint'), [])
  })

  test('lets a required capability own its exact optional file set', assert => {
    const seen = []
    const feature = rdk.graph({
      '/test/message': rdk.value('hello'),
      '/package-manager/exec': rdk.value(invocation => `resolve ${invocation}`),
      '/test/generated': file({ message: rdk.one('/test/message') }, {
        for: ['test'],
        render(context, { message }) {
          seen.push({ intent: context.intent, facet: context.facet, host: context.host })
          return { RUN: `write ${message}` }
        },
      }),
      '/test/host-aware': file({}, {
        for: ['test'],
        render: context => ({ CMD: ['done', context.host.arch] }),
      }),
      '/test/skipped': file({}, {
        for: ['build'],
        render: () => ({ RUN: 'wrong intent' }),
      }),
      '/test/runner': command({
        message: rdk.one('/test/message'),
        files: rdk.many(
          '/test/generated',
          '/test/host-aware',
          '/test/skipped',
          '/test/absent',
        ),
      }, {
        for: ['test'],
        run: ({ message }) => [
          { tool: `${message} suite` },
          { shell: 'echo done > /tmp/log' },
        ],
      }),
      '/runner': adapter('/test/runner'),
      '/target/quality/inspect': target({
        exec: rdk.one('/package-manager/exec'),
        runner: rdk.one('/runner'),
      }, {
        intent: 'test',
        render: (context, { exec, runner }) => ({
          deps: [],
          run: ({ host }) => ({
            FROM: 'scratch',
            steps: [
              ...context.files(runner.files, { host }),
              ...runSteps(runner.invocations, exec),
            ],
            IGNORE: [],
          }),
        }),
      }),
    })

    const index = recipe([feature])({ location: '//example' })
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
      () => sourceTarget({ files: ['/test/**'] }),
      'sourceTarget files must be exact semantic paths: /test/\\*\\*',
    )
    assert.throws(
      () => command({ files: rdk.many('/test/**') }, {
        for: ['test'],
        run: () => ({ tool: 'test' }),
      }),
      'command contribution files must use many\\(\\) with exact semantic paths',
    )
  })

  test('derives target identity from paths and resolves collisions by normal replacement', assert => {
    const contribution = (facet, owner) => rdk.graph({
      [`/target/${facet}/same`]: target({}, {
        render: () => ({
          deps: [],
          run: () => ({ FROM: owner, steps: [], IGNORE: [] }),
        }),
      }),
    })

    const twoFacets = recipe([contribution('ci', 'ci'), contribution('dev', 'dev')])({
      location: '//example',
    })
    assert.equal(twoFacets.ci.same.name, 'same')
    assert.equal(twoFacets.dev.same.name, 'same')

    const replaced = recipe([
      contribution('ci', 'first'),
      contribution('ci', 'second'),
    ])({ location: '//example' })
    assert.equal(replaced.ci.same.run().FROM, 'second')
  })

  test('materializes one invocation as both a container step and a manager script', assert => {
    const withManager = manager => recipe([
      typescript({ base: '//base:ci:image', versions }), manager,
      library({ runtime: 'node' }), vitest(), eslint(),
    ])({ location: '//packages/example' })

    for (const [manager, install, exec] of [
      [pnpm(), 'pnpm install --prod=false', 'pnpm exec tsc'],
      [npm(), 'npm install --include=dev', 'npm exec -- tsc'],
    ]) {
      const index = withManager(manager)
      const build = runTarget(index, 'ci', 'build')

      // The container resolves the tool through the manager and installs first.
      assert.deepEqual(
        build.steps.filter(step => step.RUN && !step.RUN.startsWith('echo')).map(step => step.RUN),
        [install, exec],
      )
      // The very same declarations, as scripts, where no resolution prefix belongs.
      assert.deepEqual(written(build.steps, 'package.json').scripts, {
        typecheck: 'tsc --noEmit',
        test: 'vitest run',
        lint: 'eslint .',
        build: 'tsc',
      })
      // A published manifest carries no scripts, like it carries no devDependencies.
      assert.equal(
        'scripts' in written(runTarget(index, 'publish', 'pack').steps, 'package.json'),
        false,
      )
    }

    // Replacing the exact capability also replaces the package.json script that projects it.
    const extended = recipe([
      typescript({ base: '//base:ci:image', versions }), pnpm(), library({ runtime: 'node' }),
      rdk.graph({
        '/verified/compiler': command({}, {
          for: ['build'],
          run: () => [{ tool: 'tsc' }, { shell: 'verify' }],
        }),
        '/typescript/compiler': adapter('/verified/compiler'),
      }),
    ])({ location: '//packages/example' })
    const build = runTarget(extended, 'ci', 'build')
    assert.equal(written(build.steps, 'package.json').scripts.build, 'tsc && verify')
    assert.deepEqual(build.steps.slice(-2).map(step => step.RUN), ['pnpm exec tsc', 'verify'])
  })

  test('configures rollup from facts the recipe already has', assert => {
    const rollupVersions = {
      ...versions,
      '@rollup/plugin-commonjs': '29',
      '@rollup/plugin-node-resolve': '16',
      rollup: '4',
    }
    const index = recipe([
      typescript({
        base: '//base:ci:image',
        versions: rollupVersions,
        outputDirectory: 'build',
      }),
      pnpm(),
      library({ runtime: 'node' }),
      rollup(),
    ])({ location: '//packages/example' })

    const bundle = runTarget(index, 'ci', 'bundle')
    assert.deepEqual(index.ci.bundle.deps, ['build'])
    assert.equal(bundle.EXPORT['/repo/dist/example.js'], 'dist/example.js')
    assert.equal(bundle.steps.at(-1).RUN, 'pnpm exec rollup --config rollup.config.js')

    // The compile output is the bundler input, and the package slug names the bundle.
    const config = writtenText(bundle.steps, 'rollup.config.js')
    assert.match(config, 'input: "build/index\\.js"')
    assert.match(config, 'file: "dist/example\\.js"')
    assert.match(config, "handler\\('error', log\\)")

    // Nothing rollup contributes leaks into the compile target that feeds it.
    const build = runTarget(index, 'ci', 'build')
    assert.equal(build.steps.some(step => step.RUN?.includes('rollup')), false)

    const lenient = recipe([
      typescript({ base: '//base:ci:image', versions: rollupVersions, outputDirectory: 'build' }),
      pnpm(), library({ runtime: 'node' }), rollup({ strict: false }),
    ])({ location: '//packages/example' })
    assert.doesNotMatch(
      writtenText(runTarget(lenient, 'ci', 'bundle').steps, 'rollup.config.js'),
      'onLog',
    )

    // A web product builds, but vite already bundles it, so there is no single entry to feed rollup.
    assert.throws(
      () => runTarget(recipe([
        typescript({ base: '//base:ci:image', versions: rollupVersions }),
        pnpm(), viteReact(), rollup(),
      ])({ location: '//web' }), 'ci', 'bundle'),
      'rollup\\(\\) needs a product that emits JavaScript',
    )
  })

  test('rejects a sibling dependency no contribution owns, qualified or bare', assert => {
    const dependent = (facet, dependency) => rdk.graph({
      [`/target/${facet}/ship`]: target({}, {
        intent: 'publish',
        render: () => ({
          deps: [dependency],
          run: () => ({ FROM: 'scratch', steps: [], IGNORE: [] }),
        }),
      }),
    })

    // A bare name resolves against the depending target's own facet. The check runs when the facet
    // expands, because that is when its targets exist.
    assert.throws(
      () => recipe([dependent('publish', 'build')])({ location: '//example' }),
      'target "publish:ship" depends on "build", which no contribution owns',
    )
    assert.throws(
      () => recipe([dependent('publish', 'ci:build')])({ location: '//example' }),
      'target "publish:ship" depends on "ci:build", which no contribution owns',
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
      recipe([dependent('ci', '//packages/core:ci:pack')])({ location: '//example' })
        .ci.ship.deps,
      ['//packages/core:ci:pack'],
    )
  })

  const invalidBuild = contribution => recipe([contribution, rdk.graph({
    '/target/ci/build': target({ files: rdk.many('/invalid/file') }, {
      intent: 'build',
      render: (context, { files }) => ({
        deps: [],
        run: () => ({ FROM: 'scratch', steps: context.files(files), IGNORE: [] }),
      }),
    }),
  })])({ location: '//example' }).ci.build.run({ images: {} })

  const notAStep = 'file contribution render must return a Dagr step or an array of steps'
  const notAnInvocation = 'an invocation needs exactly one of tool or shell, naming what to run'

  test('rejects a file that renders undefined', assert => {
    assert.throws(
      () => invalidBuild(rdk.graph({
        '/invalid/file': file({}, { for: ['build'], render: () => undefined }),
      })),
      notAStep,
    )
  })

  test('rejects a file that renders a falsy step', assert => {
    assert.throws(
      () => invalidBuild(rdk.graph({
        '/invalid/file': file({}, { for: ['build'], render: () => [false] }),
      })),
      notAStep,
    )
  })

  test('rejects a command that returns a step instead of an invocation', assert => {
    assert.throws(
      () => rdk.graph({
        '/invalid/command': command({}, { for: ['build'], run: () => ({ RUN: 'a step' }) }),
      }).compile(['/invalid/command']),
      notAnInvocation,
    )
  })

  test('rejects an invocation naming both a tool and a shell', assert => {
    assert.throws(
      () => rdk.graph({
        '/invalid/command': command({}, {
          for: ['build'], run: () => ({ tool: 'a', shell: 'b' }),
        }),
      }).compile(['/invalid/command']),
      notAnInvocation,
    )
  })

  test('rejects a command that declares no intents', assert => {
    assert.throws(
      () => rdk.graph({
        '/invalid/command': command({}, { run: () => ({ tool: 'a' }) }),
      }),
      'command contribution needs for, the intents whose run it is',
    )
  })

  test('rejects a required package with no catalog version', assert => {
    // The catalog is the real dagr.versions.yaml, so this names something it cannot contain.
    const unpublished = nodeLibrary(rdk.graph({
      '/unknown/tooling': tooling({ packages: ['definitely-not-a-published-package'] }),
      '/unknown/package-json/dependencies': packageJsonDependencies('/unknown/tooling'),
    }))({ location: '//packages/example' })

    assert.throws(
      () => unpublished.ci.build.run({ images: { '//base:ci:image': 'base' } }),
      'No version configured for package "definitely-not-a-published-package"',
    )
  })

  test('renders coherent files from one context without intent-aware graph values', assert => {
    const index = nodeLibrary(
      prettier({ semi: true, trailingComma: 'all' }),
      vitest({ globals: true }),
      eslint({ prettier: true }),
      typedoc({ title: 'Example' }),
    )({ location: '//packages/example', version: '1.2.3' })

    const build = runTarget(index, 'ci', 'build')
    const tested = runTarget(index, 'ci', 'test')
    const lint = runTarget(index, 'ci', 'lint')
    const docs = runTarget(index, 'ci', 'docs')

    const manifest = written(build.steps, 'package.json')
    const config = written(build.steps, 'tsconfig.json')
    assert.equal(manifest.main, './src/index.ts')
    assert.equal(manifest.devDependencies.typescript, '6')
    assert.equal(manifest.devDependencies['@types/node'], '22')
    assert.equal(config.compilerOptions.outDir, 'dist')
    assert.equal(config.compilerOptions.noEmit, false)
    assert.deepEqual(config.exclude, ['src/**/*.test.ts', 'src/**/*.spec.ts'])
    assert.equal(build.steps.at(-2).RUN, 'pnpm install --prod=false')
    assert.equal(build.steps.at(-1).RUN, 'pnpm exec tsc')

    assert.deepEqual(written(tested.steps, 'tsconfig.json').compilerOptions.types.sort(), [
      'node', 'vitest/globals',
    ])
    assert.ok(lint.steps.some(step => step.RUN?.endsWith('> /repo/.prettierrc.json')))
    assert.ok(lint.steps.some(step => step.RUN?.endsWith('> /repo/eslint.config.mjs')))
    assert.equal(lint.steps.at(-1).RUN, 'pnpm exec eslint .')
    assert.deepEqual(written(docs.steps, 'typedoc.json').exclude, [
      'src/**/*.test.ts', 'src/**/*.spec.ts',
    ])
  })

  test('projects a replaced ordinary source node into files and targets', assert => {
    const custom = nodeLibrary(eslint(), typedoc()).with(rdk.graph({
      '/source/directory': rdk.value('source'),
    }))
    const index = custom({ location: '//packages/example' })

    const build = runTarget(index, 'ci', 'build')
    const lint = runTarget(index, 'ci', 'lint')
    const docs = runTarget(index, 'ci', 'docs')
    assert.deepEqual(build.steps[0], { COPY: { src: 'source', dest: '/repo/source' } })
    assert.equal(written(build.steps, 'tsconfig.json').compilerOptions.rootDir, 'source')
    assert.match(writtenText(lint.steps, 'eslint.config.mjs'), 'source/\\*\\*/\\*\\.ts')
    assert.deepEqual(written(docs.steps, 'typedoc.json').entryPoints, ['source/index.ts'])
  })

  test('selects one replaceable TypeScript compiler through an exact binding', assert => {
    const extension = rdk.graph({
      '/verified/compiler': command({}, {
        for: ['build'], run: () => [{ tool: 'tsc' }, { shell: 'verify build' }],
      }),
      '/typescript/compiler': adapter('/verified/compiler'),
    })
    const index = nodeLibrary().with(extension)({ location: '//packages/example' })
    const build = runTarget(index, 'ci', 'build')

    assert.equal(build.steps.at(-2).RUN, 'pnpm exec tsc')
    assert.equal(build.steps.at(-1).RUN, 'verify build')
    assert.equal(written(build.steps, 'package.json').scripts.build, 'tsc && verify build')
  })

  test('derives worker and Vite outputs from their product facts', assert => {
    const worker = recipe([
      typescript({ base: '//base:ci:image', versions }), npm(), cloudflareWorker(),
    ])({ location: '//worker' })
    const workerTypecheck = runTarget(worker, 'ci', 'typecheck')
    assert.deepEqual(written(workerTypecheck.steps, 'tsconfig.json').compilerOptions.types, [
      '@cloudflare/workers-types',
    ])
    assert.deepEqual(written(workerTypecheck.steps, 'package.json').imports, { '#/*': './src/*' })

    const web = recipe([
      typescript({ base: '//base:ci:image', versions }), yarn(), viteReact(),
      vitest({ environment: 'jsdom' }),
    ])({ location: '//web' })
    const tested = runTarget(web, 'ci', 'test')
    const build = runTarget(web, 'ci', 'build')
    assert.deepEqual(written(build.steps, 'tsconfig.json').compilerOptions.lib, [
      'ES2020', 'DOM', 'DOM.Iterable',
    ])
    assert.equal(written(build.steps, 'package.json').dependencies.react, '19')
    assert.ok(build.steps.some(step => step.COPY?.src === 'index.html'))
    assert.match(writtenText(tested.steps, 'vitest.config.ts'), 'mergeConfig\\(viteConfig')
  })

  return { results }
}
