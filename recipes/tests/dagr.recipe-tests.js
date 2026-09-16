import recipe, {
  adapter,
  cloudflareWorker,
  file,
  fileTarballs,
  hoister,
  library,
  npm,
  pnpm,
  rdk,
  typescript,
  viteReact,
  vitest,
  yarn,
} from '//recipes/tests/typescript//dagr.recipe.js'
import { suite } from '//recipes/tests/dagr.testing.js'

const versions = {
  '@tailwindcss/vite': '4',
  '@tsconfig/strictest': '2',
  '@types/node': '22',
  '@vitejs/plugin-react': '4',
  'class-variance-authority': '0.7',
  clsx: '2',
  react: '19',
  'react-dom': '19',
  'react-router-dom': '7',
  'tailwind-merge': '3',
  tailwindcss: '4',
  typescript: '6',
  vite: '5',
  vitest: '3',
}

const writtenText = (steps, path) => {
  const step = steps.find(candidate => candidate.RUN?.endsWith(`> /repo/${path}`))
  if (step === undefined) throw new Error(`${path} was not written`)
  return Buffer.from(step.RUN.match(/^echo "([^"]+)"/)[1], 'base64').toString('utf8')
}

const written = (steps, path) => JSON.parse(writtenText(steps, path))

const runTarget = (built, extra = {}) => built.run({
  images: Object.fromEntries(built.deps.map(dependency => [dependency, `${dependency}-image`])),
  ...extra,
})

/**
 * The recipe's own tests. They run while this package's graph expands, so `dagr:rdk` is the builtin
 * the engine serves and generated files are produced by the real writers — which is why the YAML
 * assertions below check YAML rather than JSON.
 */
export default function recipeTests() {
  const { test, results } = suite('mountable TypeScript recipe')

  test('exposes only contributed facets and targets', assert => {
    const index = recipe([
      typescript({ base: '//base:ci:image', versions, sourceDirectory: 'source' }),
      pnpm(),
      library(),
      vitest(),
    ])({ location: '//example', version: '1.0.0' })

    assert.deepEqual(Object.keys(index), ['ci', 'publish'])
    assert.deepEqual(Object.keys(index.ci()), ['typecheck', 'build', 'pack', 'test'])
    assert.deepEqual(Object.keys(index.publish()), ['pack'])
    assert.deepEqual(index.ci().typecheck.deps, ['//base:ci:image'])
    assert.deepEqual(runTarget(index.ci().typecheck).steps[0], {
      COPY: { src: 'source', dest: '/repo/source' },
    })
    assert.deepEqual(index.publish().pack.deps, ['ci:build'])
  })

  test('installs local packages from tarballs but packs a public manifest', assert => {
    const index = recipe([
      typescript({ base: '//base:ci:image', versions }),
      pnpm(),
      library(),
    ])({
      location: '//packages/example',
      version: '1.0.0',
      deps: [{ facet: '//packages/core:ci', at: 'prod' }],
    })

    const build = runTarget(index.ci().build)
    assert.equal(written(build.steps, 'package.json').dependencies['@internal/core'], 'file:./core.tgz')
    assert.deepEqual(build.steps[0], {
      COPY: { from: '//packages/core:ci:pack-image', src: '/out', dest: '/repo' },
    })

    const packed = runTarget(index.ci().pack)
    assert.equal(written(packed.steps, 'package.json').dependencies['@internal/core'], '>=0.0.0')
    assert.equal(packed.FROM, 'build-image')
  })

  test('a local dependency names a facet, and the recipe still chooses pack within it', assert => {
    const index = recipe([
      typescript({ base: '//base:ci:image', versions }),
      pnpm(),
      library(),
    ])({
      location: '//packages/example',
      deps: [{ facet: '//packages/core:ci', at: 'prod' }],
    })

    const build = index.ci().build
    assert.equal(
      build.deps.includes('//packages/core:ci:pack'),
      true,
      `expected a dependency on //packages/core:ci:pack, got ${JSON.stringify(build.deps)}`,
    )

    // The facet is the declaration; the package name is derived from it, not declared twice.
    assert.equal(
      written(runTarget(build).steps, 'package.json').dependencies['@internal/core'],
      'file:./core.tgz',
    )
  })

  test('rejects a local dependency that names a package instead of a facet', assert => {
    const withPackage = () => recipe([
      typescript({ base: '//base:ci:image', versions }),
      pnpm(),
      library(),
    ])({
      location: '//packages/example',
      deps: [{ pkg: '//packages/core', at: 'prod' }],
    }).ci().build

    // The manifest is where a dependency is read, so render it.
    assert.throws(
      () => runTarget(withPackage()),
      'dependency needs exactly one of facet or npm',
    )
  })

  test('rejects a facet reference with no facet', assert => {
    const withoutFacet = () => recipe([
      typescript({ base: '//base:ci:image', versions }),
      pnpm(),
      library(),
    ])({
      location: '//packages/example',
      deps: [{ facet: '//packages/core', at: 'prod' }],
    }).ci().build

    assert.throws(withoutFacet, 'Expected a local dependency facet as //package:facet')
  })

  test('expresses npm, pnpm, and yarn as ordinary nodes plus contributions', assert => {
    const indexFor = manager => recipe([
      typescript({ base: '//base:ci:image', versions }),
      manager,
      library(),
      vitest(),
    ])({ location: '//packages/example' })

    const withNpm = runTarget(indexFor(npm()).ci().test)
    assert.equal(withNpm.steps.at(-2).RUN, 'npm install --include=dev')
    assert.equal(withNpm.steps.at(-1).RUN, 'npm exec -- vitest run')

    const withPnpm = runTarget(indexFor(pnpm()).ci().test)
    assert.equal(withPnpm.steps.at(-2).RUN, 'pnpm install --prod=false')
    // Written by the real YAML stringifier, so this is YAML and not JSON.
    assert.match(
      writtenText(withPnpm.steps, 'pnpm-workspace.yaml'),
      'allowBuilds:\\s*\\n\\s+esbuild: true',
    )

    const withYarn = runTarget(indexFor(yarn()).ci().test)
    assert.equal(withYarn.steps.at(-2).RUN, 'yarn install --no-immutable')
    const yarnrc = writtenText(withYarn.steps, '.yarnrc.yml')
    assert.match(yarnrc, 'enableScripts: false')
    assert.match(yarnrc, 'nodeLinker: node-modules')
    assert.deepEqual(written(withYarn.steps, 'package.json').dependenciesMeta, {
      esbuild: { built: true },
    })

    const replaced = recipe([
      typescript({ base: '//base:ci:image', versions }),
      pnpm(),
      npm(),
      library(),
      vitest(),
    ])({ location: '//packages/example' })
    const npmAfterPnpm = runTarget(replaced.ci().test)
    assert.equal(npmAfterPnpm.steps.some(step => step.RUN?.endsWith('pnpm-workspace.yaml')), false)
    assert.equal(npmAfterPnpm.steps.at(-2).RUN, 'npm install --include=dev')
  })

  test('hoists structurally marked files and passes host context only to that materialization', assert => {
    const extra = rdk.graph({
      '/example/file': file({}, {
        for: ['dev'],
        render: () => ({ RUN: 'write directly hoisted' }),
      }),
      '/example/file/hoisted': adapter('/example/file'),
      '/example/editor': file({}, {
        for: ['dev'],
        render: () => ({ RUN: 'write grouped hoisted' }),
      }),
      '/example/group/hoisted/editor': adapter('/example/editor'),
      '/example/unhoisted': file({}, {
        for: ['dev'],
        render: () => ({ RUN: 'write unhoisted' }),
      }),
    })
    const index = recipe([
      typescript({ base: '//base:ci:image', versions }),
      yarn(),
      viteReact(),
      extra,
      hoister(),
    ])({ location: '//packages/web' })

    const hoist = runTarget(index.dev().hoist, { host: { os: 'linux', arch: 'arm64' } })
    const yarnrc = writtenText(hoist.steps, '.yarnrc.yml')
    assert.match(yarnrc, 'supportedArchitectures:')
    assert.match(yarnrc, 'arm64')
    assert.equal(hoist.steps.some(step => step.RUN === 'write directly hoisted'), true)
    assert.equal(hoist.steps.some(step => step.RUN === 'write grouped hoisted'), true)
    assert.equal(hoist.steps.some(step => step.RUN === 'write unhoisted'), false)
    assert.deepEqual(hoist.EXPORT, { '/repo/': './' })
    assert.equal(hoist.steps.some(step => step.COPY?.src === 'src'), false)
    assert.equal(hoist.steps.some(step => step.RUN?.includes('install')), false)

    // Only the hoisting materialization is host-aware.
    const build = runTarget(index.ci().build, { host: { os: 'linux', arch: 'arm64' } })
    assert.doesNotMatch(writtenText(build.steps, '.yarnrc.yml'), 'supportedArchitectures')
  })

  test('supports a custom manager as a normal feature graph', assert => {
    const bun = rdk.graph({
      '/package-manager/install-manifest': rdk.value(fileTarballs),
      '/package-manager/exec': rdk.value(invocation => `bun x ${invocation}`),
      '/package-manager/script': rdk.value(invocation => invocation),
      '/package-manager/install': rdk.value(() => 'bun install'),
      '/package-manager/pack': rdk.value(slug => `bun pm pack --destination /out --filename ${slug}.tgz`),
      '/package-manager/config': file({}, {
        for: ['dev', 'typecheck', 'test', 'lint', 'docs', 'build'],
        render: () => ({ RUN: 'write bunfig.toml' }),
      }),
      '/package-manager/config/hoisted': adapter('/package-manager/config'),
    })
    const index = recipe([
      typescript({ base: '//base:ci:image', versions }),
      bun,
      library(),
    ])({ location: '//packages/example' })

    const typecheck = runTarget(index.ci().typecheck)
    assert.ok(typecheck.steps.some(step => step.RUN === 'write bunfig.toml'))
    assert.equal(typecheck.steps.at(-2).RUN, 'bun install')
    assert.equal(typecheck.steps.at(-1).RUN, 'bun x tsc --noEmit')
    assert.equal(
      runTarget(index.ci().pack).steps.at(-1).RUN,
      'bun pm pack --destination /out --filename example.tgz',
    )
  })

  test('keeps the declaration irreducible and right-biased', assert => {
    const index = recipe([
      typescript({ base: '//base:ci:image', versions }),
      npm(),
      library(),
      rdk.graph({ '/package/location': rdk.value('//wrong') }),
    ])({ location: '//packages/example', metadata: { description: 'Example' } })

    const manifest = written(runTarget(index.ci().typecheck).steps, 'package.json')
    assert.equal(manifest.name, '@internal/example')
    assert.equal(manifest.description, 'Example')
  })

  test('requires only canonical state and exact capabilities reached by targets', assert => {
    assert.throws(() => typescript({}), 'requires a base target')

    // A library needs a package manager to resolve its tools and install them.
    assert.throws(
      () => recipe([typescript({ base: '//base:ci:image', versions }), library()])({ location: '//x' }),
      'Missing binding "/package-manager/exec" required by "/target/ci/typecheck"',
    )
    assert.throws(
      () => recipe([
        typescript({ base: '//base:ci:image', versions }),
        rdk.graph({
          '/package-manager/exec': rdk.value(String),
          '/package-manager/install': rdk.value(String),
          '/package-manager/script': rdk.value(String),
        }),
        library(),
      ])({ location: '//x' }),
      'Missing binding "/package-manager/install-manifest" required by "/typescript/package-json"',
    )
    assert.deepEqual(
      recipe([typescript({ base: '//base:ci:image', versions }), npm()])({ location: '//x' }),
      {},
    )
    assert.throws(
      () => recipe([
        typescript({ base: '//base:ci:image', versions }), npm(), library(),
      ])({}),
      'requires a location',
    )
    assert.throws(() => recipe([{ location: '//x' }]), 'Can only merge another graph')
  })

  test('derives worker outputs from its product facts', assert => {
    const worker = recipe([
      typescript({ base: '//base:ci:image', versions }), npm(), cloudflareWorker(),
    ])({ location: '//worker' })
    const typecheck = runTarget(worker.ci().typecheck)

    assert.deepEqual(written(typecheck.steps, 'package.json').imports, { '#/*': './src/*' })
  })

  return { results }
}
