import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadTypeScript } from './dagr.typescript-loader.js'

const {
  biome,
  cloudflareWorker,
  di,
  eslint,
  library,
  prettier,
  requires,
  typedoc,
  viteReact,
  vitest,
  typescriptModule,
  workspaceKey,
} = await loadTypeScript()

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
  'clsx': '2',
  'eslint': '9',
  'eslint-plugin-prettier': '5',
  'jsdom': '30',
  'prettier': '3',
  'react': '19',
  'react-dom': '19',
  'react-router-dom': '7',
  'tailwind-merge': '3',
  'tailwindcss': '4',
  'typedoc': '0.28',
  'typescript': '6',
  'vite': '5',
  'vitest': '3',
  'wrangler': '4',
}

const withWorkspaces = module => {
  const nodes = Object.freeze(Object.fromEntries([...module.keys()].map(name => [
    name,
    module.definitionOf(name),
  ])))
  return Object.freeze({
    module,
    graph: Object.freeze({ nodes }),
    workspace: name => {
      const key = workspaceKey(name, 'workspace')
      return module.shake([key]).compile()[key]
    },
  })
}

const mergeFeatures = features => features.reduce(
  (module, feature) => module.merge(feature),
  di.module({}),
)

const moduleFor = features => withWorkspaces(typescriptModule({
  location: '//packages/example',
  scope: 'internal',
  version: '1.2.3',
  deps: [],
  metadata: { description: 'Example' },
  versions,
  features: mergeFeatures(features),
}))

describe('composable TypeScript workspaces', () => {
  it('merges feature definitions into one native DI module', () => {
    const features = [
      library({ runtime: 'node' }),
      prettier(),
      vitest({ globals: true }),
      eslint({ prettier: true }),
      typedoc(),
    ]
    const { graph, workspace } = moduleFor(features)

    assert.equal(features[0].role, undefined)
    assert.equal(features[0].execution, undefined)
    const dev = name => `dev:sync/${name}`
    assert.ok(graph.nodes[dev('moduleKind')])
    assert.ok(graph.nodes[dev('outputDirectory')])
    assert.deepEqual(graph.nodes[dev('outputDirectory')].deps, [])
    assert.ok(graph.nodes[dev('vitest.test.environment')])
    assert.ok(graph.nodes[dev('packageJson.main')])
    assert.ok(graph.nodes[dev('tsconfig.compilerOptions.outDir')])
    assert.deepEqual(graph.nodes[dev('packageJson.main')].deps, [dev('runtimeEntry')])
    assert.deepEqual(graph.nodes[dev('packageJson.files')].deps, [
      dev('productKind'),
      dev('distributionIntent'),
      dev('emittedArtifacts'),
    ])
    assert.deepEqual(graph.nodes[dev('tsconfig.compilerOptions.outDir')].deps, [
      dev('emissionIntent'),
      dev('outputLayout'),
    ])
    assert.deepEqual(graph.nodes[dev('prettierToolPackages')].tags, [dev('toolPackages')])
    assert.deepEqual(graph.nodes[dev('prettierGeneratedFiles')].tags, [dev('generatedFiles')])
    assert.deepEqual(graph.nodes[dev('vitestAmbientTypes')].tags, [dev('ambientTypes')])
    assert.deepEqual(graph.nodes[dev('vitestAllowBuilds')].tags, [dev('allowBuilds')])
    assert.ok(graph.nodes[dev('vitestIntents')])
    assert.ok(graph.nodes[dev('prettierIntents')])
    assert.ok(graph.nodes[dev('eslintIntents')])
    assert.ok(graph.nodes[dev('typedocIntents')])
    assert.equal(graph.nodes[dev('viteIntents')], undefined)
    assert.deepEqual(graph.nodes[dev('featureToolPackages')].deps, [{ tag: dev('toolPackages') }])
    assert.deepEqual(graph.nodes[dev('featureVersionDefaults')].deps, [{ tag: dev('versionDefaults') }])
    assert.deepEqual(graph.nodes[dev('featureValidations')].deps, [{ tag: dev('validations') }])
    assert.deepEqual(graph.nodes.libraryBuildTarget.deps, [
      { tag: 'buildDependencies' },
      'ci:build/workspace',
      '#dagrRuntime',
    ])
    assert.equal(graph.nodes.vitestTestTarget.tags[0].description, 'ci targets')
    assert.equal(graph.nodes.vitestTestTarget.tags[1], 'buildDependencies')
    assert.equal(graph.nodes[dev('libraryTsconfig')], undefined)
    assert.equal(graph.nodes[dev('featurePackageFields')], undefined)
    assert.equal(graph.contributions, undefined)

    const pack = workspace('ci:pack')
    assert.deepEqual(pack.semantics.outputLayout, {
      directory: 'dist',
      runtimeFile: 'dist/index.js',
      declarationFile: 'dist/index.d.ts',
    })
    assert.equal(pack.semantics.runtimeEntry, './dist/index.js')
    assert.equal(pack.semantics.declarationEntry, './dist/index.d.ts')
    assert.deepEqual(pack.semantics.emittedArtifacts, ['dist'])
    assert.equal(pack.packageJson.main, './dist/index.js')
    assert.equal(pack.packageJson.types, './dist/index.d.ts')
    assert.deepEqual(pack.packageJson.files, ['dist'])
    assert.equal(pack.tsconfig.compilerOptions.outDir, 'dist')
    assert.deepEqual(Object.keys(workspace('dev:sync').files), [
      'package.json',
      'tsconfig.json',
      '.prettierrc.json',
      'vitest.config.ts',
      'eslint.config.mjs',
      'typedoc.json',
    ])
  })

  it('gets capability policy and fallback versions only from active features', () => {
    const module = typescriptModule({
      location: '//packages/example',
      scope: 'internal',
      version: '1.2.3',
      deps: [],
      metadata: {},
      defaultVersions: {
        '@tsconfig/strictest': '2.0.8',
        typescript: '6.0.3',
      },
      versions: { vitest: 'repository-choice' },
      features: mergeFeatures([library({ runtime: 'node' }), vitest()]),
    })
    const { graph, workspace } = withWorkspaces(module)
    const dev = workspace('dev:sync')

    assert.ok(graph.nodes['dev:sync/vitestIntents'])
    assert.equal(graph.nodes['dev:sync/eslintIntents'], undefined)
    assert.equal(dev.packageJson.devDependencies.typescript, '6.0.3')
    assert.equal(dev.packageJson.devDependencies['@types/node'], '26.2.0')
    assert.equal(dev.packageJson.devDependencies.vitest, 'repository-choice')
  })

  it('treats conventions as replaceable roots of the semantic graph', () => {
    const { workspace } = withWorkspaces(typescriptModule({
      location: '//packages/example',
      scope: 'internal',
      version: '1.2.3',
      deps: [],
      metadata: {},
      versions,
      features: mergeFeatures([library()]),
      conventions: { sourceDirectory: 'source', outputDirectory: 'build' },
    }))

    const pack = workspace('ci:pack')
    assert.deepEqual(pack.semantics.outputLayout, {
      directory: 'build',
      runtimeFile: 'build/index.js',
      declarationFile: 'build/index.d.ts',
    })
    assert.deepEqual(pack.semantics.sourceLayout, { directory: 'source', entry: 'index.ts' })
    assert.equal(workspace('ci:build').tsconfig.compilerOptions.outDir, 'build')
    assert.equal(workspace('ci:build').tsconfig.compilerOptions.rootDir, 'source')
    assert.deepEqual(pack.packageJson.files, ['build'])
    assert.equal(pack.packageJson.main, './build/index.js')
  })

  it('projects source conventions into every tool that consumes source paths', () => {
    const { workspace } = withWorkspaces(typescriptModule({
      location: '//packages/example',
      scope: 'internal',
      version: '1.2.3',
      deps: [],
      metadata: {},
      versions,
      features: mergeFeatures([library(), eslint(), typedoc()]),
      conventions: { sourceDirectory: 'source' },
    }))

    const lint = workspace('ci:lint')
    const docs = workspace('ci:docs')
    assert.match(lint.files['eslint.config.mjs'], /source\/\*\*\/\*\.ts/)
    assert.deepEqual(docs.files['typedoc.json'].exclude, [
      'source/**/*.test.ts',
      'source/**/*.spec.ts',
    ])
  })

  it('derives Wyr-style library workspaces from intent and target', () => {
    const { workspace } = moduleFor([
      library({ runtime: 'node', language: 'ES2023', sourceMaps: true, assets: ['README.md', 'LICENSE'] }),
      prettier({ semi: true, trailingComma: 'all' }),
      vitest({ globals: true, typecheck: true }),
      eslint({ prettier: true }),
      typedoc({ title: 'Wyr' }),
    ])
    const dev = workspace('dev:sync')
    const build = workspace('ci:build')
    const docs = workspace('ci:docs')
    const pack = workspace('ci:pack')
    const publish = workspace('publish:pack')

    assert.equal(dev.tsconfig.compilerOptions.module, 'NodeNext')
    assert.equal(dev.tsconfig.compilerOptions.noEmit, true)
    assert.deepEqual(dev.tsconfig.compilerOptions.types, ['node', 'vitest/globals'])
    assert.deepEqual(workspace('ci:typecheck').tsconfig.exclude, [
      'src/**/*.test.ts',
      'src/**/*.spec.ts',
    ])
    assert.equal(dev.files['.prettierrc.json'].semi, true)
    assert.deepEqual(workspace('ci:lint').files['.prettierrc.json'], {
      $schema: 'https://json.schemastore.org/prettierrc',
      semi: true,
      tabWidth: 2,
      singleQuote: true,
      printWidth: 100,
      trailingComma: 'all',
    })
    assert.match(workspace('ci:lint').files['eslint.config.mjs'], /"no-dupe-class-members":"off"/)
    assert.match(dev.files['vitest.config.ts'], /typecheck: \{ enabled: true \}/)
    assert.deepEqual(build.buildAssets, ['README.md', 'LICENSE'])
    assert.deepEqual(docs.tsconfig.exclude, ['src/**/*.test.ts', 'src/**/*.spec.ts'])
    assert.equal(build.tsconfig.compilerOptions.noEmit, false)
    assert.equal(build.tsconfig.compilerOptions.sourceMap, true)
    assert.equal(pack.packageJson.private, true)
    assert.equal(publish.packageJson.private, false)
    assert.equal(pack.packageJson.main, './dist/index.js')
  })

  it('projects one import alias to source and runtime destinations', () => {
    const aliases = di.module({
      importAlias: di.toFun(
        ['sourceDirectory', 'outputDirectory'],
        (source, output) => ({
          specifier: '#*',
          sourcePath: `./${source}/*`,
          runtimePath: `./${output}/*`,
        }),
      ),
    })
    const { workspace } = moduleFor([library({ runtime: 'node' }), aliases])
    const build = workspace('ci:build')

    assert.deepEqual(build.tsconfig.compilerOptions.paths, { '#*': ['./src/*'] })
    assert.deepEqual(build.packageJson.imports, { '#*': './dist/*' })
  })

  it('derives worker policy instead of accepting raw tsconfig', () => {
    const { workspace } = moduleFor([cloudflareWorker(), prettier()])
    const dev = workspace('dev:sync')

    assert.equal(dev.packageJson.imports['#/*'], './src/*')
    assert.deepEqual(dev.tsconfig.compilerOptions.paths['#/*'], ['./src/*'])
    assert.equal(dev.tsconfig.compilerOptions.moduleResolution, 'NodeNext')
    assert.deepEqual(dev.tsconfig.compilerOptions.types, ['@cloudflare/workers-types'])
    assert.deepEqual(dev.allowBuilds.sort(), ['sharp', 'workerd'])
  })

  it('derives the Vite React runtime, browser compiler, and test environment', () => {
    const { graph, workspace } = moduleFor([
      viteReact(),
      prettier(),
      eslint(),
      vitest({ environment: 'jsdom' }),
    ])
    const dev = workspace('dev:sync')
    const build = workspace('ci:build')

    assert.deepEqual(graph.nodes['dev:sync/vite.resolve.alias'].deps, ['dev:sync/importAlias'])
    assert.equal(dev.packageJson.dependencies.react, '19')
    assert.deepEqual(dev.packageJson.imports, { '#/*': './src/*' })
    assert.deepEqual(dev.tsconfig.compilerOptions.paths, { '#/*': ['./src/*'] })
    assert.match(dev.files['vite.config.ts'], /"#\/": fileURLToPath\(new URL\("\.\/src\/"/)
    assert.deepEqual(dev.tsconfig.compilerOptions.lib, ['ES2020', 'DOM', 'DOM.Iterable'])
    assert.match(dev.files['vitest.config.ts'], /environment: "jsdom"/)
    assert.deepEqual(build.buildAssets, ['index.html', 'public'])
    assert.deepEqual(build.output, { directory: 'dist' })
  })

  it('lets an ordinary feature contribute Biome settings, files, packages, and targets', () => {
    const { graph, workspace } = moduleFor([library(), biome()])
    const dev = workspace('dev:sync')

    assert.ok(graph.nodes['dev:sync/biomeConfig'])
    assert.deepEqual(graph.nodes['dev:sync/biomeToolPackages'].tags, ['dev:sync/toolPackages'])
    assert.deepEqual(graph.nodes['dev:sync/biomeGeneratedFiles'].tags, ['dev:sync/generatedFiles'])
    assert.equal(graph.nodes.biomeLintTarget.tags[0].description, 'ci targets')
    assert.equal(graph.nodes.biomeLintTarget.tags[1], 'buildDependencies')
    assert.equal(dev.packageJson.devDependencies['@biomejs/biome'], '2')
    assert.deepEqual(dev.files['biome.json'], {
      formatter: { enabled: true },
      linter: { enabled: true },
    })
  })

  it('lets features extend ESLint rules through settings and fails without ESLint', () => {
    const companyRules = di.module({
      companyEslintRequirement: requires('eslint.enabled'),
      companyEslintRules: di.toValue(
        { '@typescript-eslint/consistent-type-imports': 'error' },
        ['eslint.ruleSets'],
      ),
    })

    const lint = moduleFor([library(), eslint(), companyRules]).workspace('ci:lint')
    assert.match(lint.files['eslint.config.mjs'], /consistent-type-imports/)
    assert.throws(
      () => moduleFor([library(), companyRules]).workspace('dev:sync'),
      /Missing binding "dev:sync\/eslint.enabled" required by "dev:sync\/companyEslintRequirement"/,
    )
  })

  it('rejects derived package fields disguised as metadata', () => {
    const module = typescriptModule({
      location: '//packages/example',
      scope: 'internal',
      version: '1.2.3',
      metadata: { private: false },
      versions,
      features: mergeFeatures([library()]),
    })
    const { workspace } = withWorkspaces(module)
    assert.throws(() => workspace('dev:sync'), /cannot configure non-metadata field private/)
  })
})
