import bundledVersions from '//dagr.versions.yaml'
import rdk from 'dagr:rdk'
import { command, file, filesFor, target } from '//dagr.contributions.js'
import { writeJson, writeText } from '//dagr.file-utils.js'
import { RECOMMENDED_IGNORE } from '//dagr.dockerignore.js'
import {
  DEVELOPMENT_INTENTS,
  DISTRIBUTION_INTENTS,
  adapter,
  copyAssets,
  copyLocalPackages,
  copySource,
  localPackagesOf,
  packageJsonDependencies,
  packageManagerBuilds,
  packagesFor,
  present,
  projectName,
  runSteps,
  scriptsFor,
  tooling,
  tsconfigTypes,
  typesFor,
  versionOf,
} from '//dagr.model.js'

const metadataFields = Object.freeze([
  'author', 'bugs', 'contributors', 'description', 'funding', 'homepage', 'keywords', 'license', 'repository',
])

const dependencyEntries = (name, scope, deps, versions, runtimePackages) => {
  const prod = runtimePackages.map(pkg => [pkg, versionOf(versions, pkg)])
  const dev = []
  for (const dependency of deps) {
    const sources = ['pkg', 'npm'].filter(source => source in dependency)
    if (sources.length !== 1) throw new Error(`${name}: dependency needs exactly one of pkg or npm`)
    if (!['prod', 'dev'].includes(dependency.at)) {
      throw new Error(`${name}: dependency ${dependency.pkg ?? dependency.npm} needs at prod or dev`)
    }
    const entry = 'pkg' in dependency
      ? [projectName(dependency.pkg, scope), '>=0.0.0']
      : [dependency.npm, versionOf(versions, dependency.npm)]
    ;(dependency.at === 'dev' ? dev : prod).push(entry)
  }
  return { prod, dev }
}

const validateMetadata = (name, metadata) => {
  const invalid = Object.keys(metadata).filter(field => !metadataFields.includes(field))
  if (invalid.length > 0) {
    throw new Error(`${name}: package metadata cannot configure non-metadata field${invalid.length === 1 ? '' : 's'} ${invalid.join(', ')}`)
  }
  return metadata
}

const packageManifest = (
  context,
  { name, version, deps, metadata, scope, format, product, source, entry, output, alias, runtime },
  tooling,
  configuredVersions,
  scripts,
) => {
  const distribution = DISTRIBUTION_INTENTS.includes(context.intent)
  const dependencies = dependencyEntries(name, scope, deps, configuredVersions, runtime)
  const stem = entry.replace(/\.[^.]+$/, '')
  const runtimeEntry = product === 'library'
    ? `./${distribution ? `${output.directory}/${stem}.js` : `${source}/${entry}`}`
    : undefined
  const declarationEntry = product === 'library'
    ? `./${distribution ? `${output.directory}/${stem}.d.ts` : `${source}/${entry}`}`
    : undefined

  return {
    ...validateMetadata(name, metadata),
    ...present([
      ['name', name],
      ['version', version],
      ['type', format === 'esm' ? 'module' : 'commonjs'],
      ['private', context.intent !== 'publish'],
      ['main', runtimeEntry],
      ['types', declarationEntry],
      ['exports', runtimeEntry === undefined ? undefined : { '.': { types: declarationEntry, import: runtimeEntry } }],
      ['files', product === 'library' && distribution ? [output.directory] : undefined],
      ['imports', alias === undefined ? undefined : { [alias.specifier]: alias.runtimePath }],
      ['scripts', distribution || Object.keys(scripts).length === 0 ? undefined : scripts],
      ['dependencies', Object.fromEntries(dependencies.prod)],
      ['devDependencies', distribution
        ? undefined
        : Object.fromEntries([...Object.entries(tooling.packages), ...dependencies.dev])],
    ]),
  }
}

/** Bundles the facts that describe the published package, so renderers take a named record. */
const packageFacts = rdk.derive(
  {
    name: rdk.one('/package/name'),
    version: rdk.one('/package/version'),
    deps: rdk.one('/package/dependencies'),
    metadata: rdk.one('/package/metadata'),
    scope: rdk.one('/package/scope'),
    format: rdk.one('/javascript/module-format'),
    product: rdk.one('/product/kind'),
    source: rdk.one('/source/directory'),
    entry: rdk.one('/source/entry'),
    output: rdk.one('/output/layout'),
    alias: rdk.one('/source/import-alias'),
    runtime: rdk.one('/package/runtime-dependencies'),
  },
  facts => Object.freeze({ ...facts }),
)

const packageJson = file(
  {
    facts: rdk.one('/package/facts'),
    dependencies: rdk.many('/**/package-json/dependencies'),
    configuredVersions: rdk.one('/version/catalog'),
    installManifest: rdk.one('/package-manager/install-manifest'),
    localPackages: rdk.one('/package/local-dependencies'),
    scripts: rdk.one('/package/scripts'),
  },
  {
    for: [...DEVELOPMENT_INTENTS, ...DISTRIBUTION_INTENTS],
    render(context, { facts, dependencies, configuredVersions, installManifest, localPackages, scripts }) {
      const packages = packagesFor(dependencies, context, configuredVersions)
      const manifest = packageManifest(context, facts, { packages }, configuredVersions, scripts)
      return writeJson(
        '/repo/package.json',
        context.install ? installManifest(manifest, localPackages, context) : manifest,
      )
    },
  },
)

const tsconfig = file(
  {
    product: rdk.one('/product/kind'),
    language: rdk.one('/typescript/language-target'),
    sourceMaps: rdk.one('/output/source-maps'),
    emitDeclarations: rdk.one('/typescript/emit-declarations'),
    source: rdk.one('/source/directory'),
    output: rdk.one('/output/layout'),
    module: rdk.one('/typescript/module-kind'),
    moduleResolution: rdk.one('/typescript/module-resolution'),
    libraries: rdk.one('/typescript/libraries'),
    alias: rdk.one('/source/import-alias'),
    types: rdk.many('/**/tsconfig/types'),
  },
  {
    for: DEVELOPMENT_INTENTS,
    render(context, {
      product,
      language,
      sourceMaps,
      emitDeclarations,
      source,
      output,
      module,
      moduleResolution,
      libraries,
      alias,
      types: contributions,
    }) {
      const emitting = product === 'library' && ['build', 'pack', 'publish'].includes(context.intent)
      const includeTests = product !== 'library' || ['dev', 'test', 'lint'].includes(context.intent)
      const types = typesFor(contributions, context)
      return writeJson('/repo/tsconfig.json', {
        extends: '@tsconfig/strictest/tsconfig.json',
        include: [`${source}/**/${product === 'web' ? '*' : '*.ts'}`],
        ...(includeTests ? {} : { exclude: [`${source}/**/*.test.ts`, `${source}/**/*.spec.ts`] }),
        compilerOptions: {
          rootDir: source,
          ...(emitting ? { outDir: output.directory } : {}),
          target: language,
          lib: libraries,
          module,
          moduleResolution,
          noEmit: !emitting,
          ...(emitting ? { declaration: emitDeclarations } : {}),
          ...(sourceMaps && emitting ? { sourceMap: true, inlineSources: true } : {}),
          ...(types.length === 0 ? {} : { types }),
          ...(alias === undefined ? {} : { paths: { [alias.specifier]: [alias.sourcePath] } }),
          ...(product === 'web'
            ? { allowImportingTsExtensions: true, moduleDetection: 'force', jsx: 'react-jsx' }
            : {}),
        },
      })
    },
  },
)

/**
 * A target that builds the package from its own sources: local tarballs, the source tree,
 * its exact file dependencies, then one exact command capability. Installation is structural
 * here rather than a contribution, because only a fresh image needs it.
 */
export const sourceTarget = ({
  intent,
  command: commandInput,
  files = [],
  assets = false,
  export: exported,
} = {}) => {
  if (!Array.isArray(files)) {
    throw new TypeError('sourceTarget files must be an array of exact semantic paths')
  }
  const nonExact = files.filter(path => typeof path !== 'string' || path.includes('*'))
  if (nonExact.length > 0) {
    throw new TypeError(`sourceTarget files must be exact semantic paths: ${nonExact.join(', ')}`)
  }

  return target(
    {
      base: rdk.one('/image/base'),
      ignore: rdk.one('/source/ignore'),
      source: rdk.one('/source/directory'),
      localPackages: rdk.one('/package/local-dependencies'),
      exec: rdk.one('/package-manager/exec'),
      install: rdk.one('/package-manager/install'),
      files: rdk.many(
        '/typescript/package-json',
        '/package-manager/config',
        ...files,
      ),
      ...(commandInput === undefined ? {} : { command: commandInput }),
      ...(assets ? { buildAssets: rdk.one('/source/assets') } : {}),
    },
    {
      intent,
      render(context, values) {
        const {
          base, ignore, source, localPackages, exec, install, files: targetFiles,
          command: selected, buildAssets = [],
        } = values
        return {
          deps: [base, ...localPackages.map(pkg => pkg.target)],
          run: ({ images }) => ({
            FROM: images[base],
            steps: [
              ...copyLocalPackages(localPackages, images),
              copySource(source),
              ...copyAssets(buildAssets),
              { WORKDIR: '/repo' },
              ...context.files({ ...targetFiles, ...(selected?.files ?? {}) }, { install: true }),
              { RUN: install() },
              ...(selected === undefined ? [] : runSteps(selected.invocations, exec)),
            ],
            IGNORE: ignore,
            ...(exported === undefined ? {} : { EXPORT: exported }),
          }),
        }
      },
    },
  )
}

/** Materializes every structurally hoisted file contribution onto the host. */
export function hoister() {
  return rdk.graph({
    '/target/dev/hoist': target(
      {
        base: rdk.one('/image/base'),
        ignore: rdk.one('/source/ignore'),
        localPackages: rdk.one('/package/local-dependencies'),
        hoisted: rdk.many('/**/hoisted', '/**/hoisted/*'),
      },
      {
        intent: 'dev',
        render(context, { base, ignore, localPackages, hoisted }) {
          return {
            deps: [base, ...localPackages.map(pkg => pkg.target)],
            run: ({ images, host }) => ({
              FROM: images[base],
              steps: [
                ...copyLocalPackages(localPackages, images),
                { WORKDIR: '/repo' },
                ...filesFor(hoisted, {
                  intent: context.intent,
                  facet: context.facet,
                  host,
                  install: true,
                }),
              ],
              IGNORE: ignore,
              EXPORT: { '/repo/': './' },
            }),
          }
        },
      },
    ),
  })
}

/** Common facts and the two universal generated files. All values are ordinary RDK nodes. */
export function typescript({
  base,
  scope = 'internal',
  versions = {},
  sourceDirectory = 'src',
  entryFile = 'index.ts',
  outputDirectory = 'dist',
  javascriptModuleFormat = 'esm',
  ignore = RECOMMENDED_IGNORE,
} = {}) {
  if (!base) throw new Error('typescript() requires a base target')
  return rdk.graph({
    '/image/base': rdk.value(base),
    '/source/ignore': rdk.value(ignore),
    '/package/scope': rdk.value(scope),
    '/version/catalog': rdk.value(Object.freeze({ ...bundledVersions.deps, ...versions })),
    '/source/directory': rdk.value(sourceDirectory),
    '/source/entry': rdk.value(entryFile),
    '/output/directory': rdk.value(outputDirectory),
    '/javascript/module-format': rdk.value(javascriptModuleFormat),
    '/typescript/emit-declarations': rdk.value(true),
    '/package/name': rdk.derive(
      { location: rdk.one('/package/location'), scope: rdk.one('/package/scope') },
      ({ location, scope: packageScope }) => projectName(location, packageScope),
    ),
    '/package/slug': rdk.derive(
      { name: rdk.one('/package/name') },
      ({ name }) => name.slice(name.indexOf('/') + 1),
    ),
    '/source/layout': rdk.derive(
      { directory: rdk.one('/source/directory'), entry: rdk.one('/source/entry') },
      ({ directory, entry }) => ({ directory, entry }),
    ),
    '/output/layout': rdk.derive(
      {
        product: rdk.one('/product/kind'),
        directory: rdk.one('/output/directory'),
        entry: rdk.one('/source/entry'),
      },
      ({ product, directory, entry }) => {
        if (product === 'worker') return undefined
        if (product === 'web') return { directory }
        const stem = entry.replace(/\.[^.]+$/, '')
        return { directory, runtimeFile: `${directory}/${stem}.js`, declarationFile: `${directory}/${stem}.d.ts` }
      },
    ),
    '/package/local-dependencies': rdk.derive(
      { dependencies: rdk.one('/package/dependencies'), scope: rdk.one('/package/scope') },
      ({ dependencies, scope: packageScope }) => localPackagesOf(dependencies, packageScope),
    ),
    '/package/scripts': rdk.derive(
      { commands: rdk.many('/**/package-json/script'), script: rdk.one('/package-manager/script') },
      ({ commands, script }) => scriptsFor(commands, script),
    ),
    '/package/facts': packageFacts,
    '/typescript/package-json': packageJson,
    '/typescript/package-json/hoisted': adapter('/typescript/package-json'),
    '/typescript/tsconfig': tsconfig,
    '/typescript/tsconfig/hoisted': adapter('/typescript/tsconfig'),
  })
}

const typescriptPackages = runtime => [
  '@tsconfig/strictest',
  'typescript',
  ...(runtime === 'node' ? ['@types/node'] : []),
]

export function library({
  runtime = 'portable',
  language = runtime === 'node' ? 'ES2023' : 'ES2022',
  sourceMaps = false,
  assets = [],
} = {}) {
  if (!['portable', 'node'].includes(runtime)) {
    throw new Error(`library runtime must be portable or node, got ${JSON.stringify(runtime)}`)
  }
  const packages = typescriptPackages(runtime)
  const types = runtime === 'node' ? ['node'] : []
  return rdk.graph({
    '/product/kind': rdk.value('library'),
    '/runtime/kind': rdk.value(runtime),
    '/typescript/language-target': rdk.value(language),
    '/output/source-maps': rdk.value(sourceMaps),
    '/source/assets': rdk.value(Object.freeze([...assets])),
    '/package/runtime-dependencies': rdk.value(Object.freeze([])),
    '/typescript/module-kind': rdk.value(runtime === 'node' ? 'NodeNext' : 'ESNext'),
    '/typescript/module-resolution': rdk.value(runtime === 'node' ? 'NodeNext' : 'Bundler'),
    '/typescript/libraries': rdk.value(Object.freeze([language])),
    '/source/import-alias': rdk.value(undefined),
    '/library/tooling': tooling({
      packages,
      types,
    }),
    '/library/package-json/dependencies': packageJsonDependencies('/library/tooling'),
    '/library/tsconfig/types': tsconfigTypes('/library/tooling'),
    '/typescript/typechecker': command({}, {
      for: ['typecheck'],
      files: rdk.many('/typescript/tsconfig'),
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    '/typechecker': adapter('/typescript/typechecker'),
    '/typechecker/package-json/script': adapter('/typescript/typechecker'),
    '/typescript/compiler': command({}, {
      for: ['build'],
      files: rdk.many('/typescript/tsconfig'),
      run: () => ({ tool: 'tsc' }),
    }),
    '/compiler': adapter('/typescript/compiler'),
    '/compiler/package-json/script': adapter('/typescript/compiler'),
    '/target/ci/typecheck': sourceTarget({ command: rdk.one('/typechecker') }),
    '/target/ci/build': sourceTarget({ command: rdk.one('/compiler'), assets: true }),
    '/target/ci/pack': target(
      {
        ignore: rdk.one('/source/ignore'),
        localPackages: rdk.one('/package/local-dependencies'),
        pack: rdk.one('/package-manager/pack'),
        slug: rdk.one('/package/slug'),
        files: rdk.many('/typescript/package-json'),
      },
      {
        render(context, { ignore, localPackages, pack, slug, files }) {
          return {
            deps: ['build', ...localPackages.map(pkg => pkg.target)],
            run: ({ images }) => ({
              FROM: images.build,
              steps: [
                ...copyLocalPackages(localPackages, images, '/out'),
                { WORKDIR: '/repo' },
                ...context.files(files, { install: false }),
                { RUN: pack(slug) },
              ],
              IGNORE: ignore,
            }),
          }
        },
      },
    ),
    '/target/publish/pack': target(
      {
        ignore: rdk.one('/source/ignore'),
        localPackages: rdk.one('/package/local-dependencies'),
        pack: rdk.one('/package-manager/pack'),
        slug: rdk.one('/package/slug'),
        files: rdk.many('/typescript/package-json'),
      },
      {
        intent: 'publish',
        render(context, { ignore, localPackages, pack, slug, files }) {
          return {
            deps: ['ci:build', ...localPackages.map(pkg => pkg.target)],
            run: ({ images }) => ({
              FROM: images['ci:build'],
              steps: [
                ...copyLocalPackages(localPackages, images, '/out'),
                { WORKDIR: '/repo' },
                ...context.files(files, { install: false }),
                { RUN: pack(slug) },
              ],
              IGNORE: ignore,
            }),
          }
        },
      },
    ),
  })
}

export function cloudflareWorker({ language = 'ES2022' } = {}) {
  const packages = [...typescriptPackages('portable'), '@cloudflare/workers-types', 'wrangler']
  return rdk.graph({
    '/product/kind': rdk.value('worker'),
    '/runtime/kind': rdk.value('cloudflare-worker'),
    '/typescript/language-target': rdk.value(language),
    '/output/source-maps': rdk.value(false),
    '/source/assets': rdk.value(Object.freeze([])),
    '/package/runtime-dependencies': rdk.value(Object.freeze([])),
    '/typescript/module-kind': rdk.value('NodeNext'),
    '/typescript/module-resolution': rdk.value('NodeNext'),
    '/typescript/libraries': rdk.value(Object.freeze([language])),
    '/source/import-alias': rdk.derive(
      { source: rdk.one('/source/directory') },
      ({ source }) => ({
        specifier: '#/*', sourcePath: `./${source}/*`, runtimePath: `./${source}/*`,
      }),
    ),
    '/cloudflare-worker/tooling': tooling({
      packages,
      types: ['@cloudflare/workers-types'],
      builds: ['sharp', 'workerd'],
    }),
    '/cloudflare-worker/package-json/dependencies': packageJsonDependencies('/cloudflare-worker/tooling'),
    '/cloudflare-worker/tsconfig/types': tsconfigTypes('/cloudflare-worker/tooling'),
    '/cloudflare-worker/package-manager/builds': packageManagerBuilds('/cloudflare-worker/tooling'),
    '/typescript/typechecker': command({}, {
      for: ['typecheck'],
      files: rdk.many('/typescript/tsconfig'),
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    '/typechecker': adapter('/typescript/typechecker'),
    '/typechecker/package-json/script': adapter('/typescript/typechecker'),
    '/target/ci/typecheck': sourceTarget({ command: rdk.one('/typechecker') }),
  })
}

const viteRuntimePackages = Object.freeze([
  '@tailwindcss/vite',
  '@vitejs/plugin-react',
  'class-variance-authority',
  'clsx',
  'react',
  'react-dom',
  'react-router-dom',
  'tailwind-merge',
  'tailwindcss',
])

export function viteReact({ language = 'ES2020' } = {}) {
  const packages = [...typescriptPackages('node'), 'vite']
  return rdk.graph({
    '/product/kind': rdk.value('web'),
    '/runtime/kind': rdk.value('browser'),
    '/typescript/language-target': rdk.value(language),
    '/output/source-maps': rdk.value(false),
    '/source/assets': rdk.value(Object.freeze(['index.html', 'public'])),
    '/package/runtime-dependencies': rdk.value(viteRuntimePackages),
    '/typescript/module-kind': rdk.value('ESNext'),
    '/typescript/module-resolution': rdk.value('Bundler'),
    '/typescript/libraries': rdk.value(Object.freeze([language, 'DOM', 'DOM.Iterable'])),
    '/source/import-alias': rdk.derive(
      { source: rdk.one('/source/directory') },
      ({ source }) => ({
        specifier: '#/*', sourcePath: `./${source}/*`, runtimePath: `./${source}/*`,
      }),
    ),
    '/vite/tooling': tooling({
      packages,
      types: ['node'],
      builds: ['esbuild'],
    }),
    '/vite/package-json/dependencies': packageJsonDependencies('/vite/tooling'),
    '/vite/tsconfig/types': tsconfigTypes('/vite/tooling'),
    '/vite/package-manager/builds': packageManagerBuilds('/vite/tooling'),
    '/vite/config': file({ source: rdk.one('/source/directory') }, {
      for: ['dev', 'test', 'build'],
      render(_context, { source }) {
        return writeText('/repo/vite.config.ts', `import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '#/': fileURLToPath(new URL('./${source}/', import.meta.url)) } },
})
`)
      },
    }),
    '/vite/config/hoisted': adapter('/vite/config'),
    '/typescript/typechecker': command({}, {
      for: ['typecheck'],
      files: rdk.many('/typescript/tsconfig'),
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    '/typechecker': adapter('/typescript/typechecker'),
    '/typechecker/package-json/script': adapter('/typescript/typechecker'),
    '/vite/compiler': command({}, {
      for: ['build'],
      files: rdk.many('/typescript/tsconfig', '/vite/config'),
      run: () => ({ tool: 'vite build' }),
    }),
    '/compiler': adapter('/vite/compiler'),
    '/compiler/package-json/script': adapter('/vite/compiler'),
    '/target/ci/typecheck': sourceTarget({ command: rdk.one('/typechecker') }),
    '/target/ci/build': sourceTarget({ command: rdk.one('/compiler'), assets: true }),
  })
}

export function prettier({
  semi = false,
  tabWidth = 2,
  singleQuote = true,
  printWidth = 100,
  trailingComma = 'none',
} = {}) {
  return rdk.graph({
    '/prettier/tooling': tooling({
      for: ['dev'],
      packages: ['prettier'],
    }),
    '/prettier/package-json/dependencies': packageJsonDependencies('/prettier/tooling'),
    '/prettier/config': file({}, {
      for: ['dev', 'lint'],
      render: () => writeJson('/repo/.prettierrc.json', {
        $schema: 'https://json.schemastore.org/prettierrc',
        semi,
        tabWidth,
        singleQuote,
        printWidth,
        trailingComma,
      }),
    }),
    '/prettier/config/hoisted': adapter('/prettier/config'),
  })
}

export function biome({ formatter = true, linter = true } = {}) {
  return rdk.graph({
    '/biome/config': file({}, {
      for: ['dev', 'lint'],
      render: () => writeJson('/repo/biome.json', {
        formatter: { enabled: formatter },
        linter: { enabled: linter },
      }),
    }),
    '/biome/config/hoisted': adapter('/biome/config'),
    '/biome/tooling': tooling({
      for: ['dev', 'lint'],
      packages: ['@biomejs/biome'],
    }),
    '/biome/package-json/dependencies': packageJsonDependencies('/biome/tooling'),
    ...(linter ? {
      '/biome/linter': command({}, {
        for: ['lint'],
        files: rdk.many('/biome/config'),
        run: () => ({ tool: 'biome check .' }),
      }),
      '/linter': adapter('/biome/linter'),
      '/linter/package-json/script': adapter('/biome/linter'),
      '/target/ci/lint': sourceTarget({ command: rdk.one('/linter') }),
    } : {}),
  })
}

export function vitest({ environment = 'node', globals = false, typecheck = false } = {}) {
  const configDeps = environment === 'jsdom'
    ? { viteConfig: rdk.one('/vite/config') }
    : {}
  return rdk.graph({
    '/vitest/config': file(configDeps, {
      for: ['dev', 'test'],
      render() {
        if (environment === 'jsdom') return writeText('/repo/vitest.config.ts', `import { fileURLToPath } from 'node:url'
import { defineConfig, configDefaults, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(viteConfig, defineConfig({ test: {
  environment: ${JSON.stringify(environment)},
  exclude: [...configDefaults.exclude, 'e2e/**'],
  root: fileURLToPath(new URL('./', import.meta.url)),
  globals: ${globals},
  typecheck: { enabled: ${typecheck} },
} }))
`)
        return writeText('/repo/vitest.config.ts', `import { defineConfig } from 'vitest/config'

export default defineConfig({ test: {
  environment: ${JSON.stringify(environment)},
  globals: ${globals},
  typecheck: { enabled: ${typecheck} },
} })
`)
      },
    }),
    '/vitest/config/hoisted': adapter('/vitest/config'),
    '/vitest/tooling': tooling({
      for: ['dev', 'test', 'lint'],
      packages: ['vitest', ...(environment === 'jsdom' ? ['jsdom'] : [])],
      types: globals ? ['vitest/globals'] : [],
      builds: ['esbuild'],
    }),
    '/vitest/package-json/dependencies': packageJsonDependencies('/vitest/tooling'),
    '/vitest/tsconfig/types': tsconfigTypes('/vitest/tooling'),
    '/vitest/package-manager/builds': packageManagerBuilds('/vitest/tooling'),
    '/vitest/tester': command({}, {
      for: ['test'],
      files: rdk.many(
        '/typescript/tsconfig',
        '/vitest/config',
        ...(environment === 'jsdom' ? ['/vite/config'] : []),
      ),
      run: () => ({ tool: 'vitest run' }),
    }),
    '/tester': adapter('/vitest/tester'),
    '/tester/package-json/script': adapter('/vitest/tester'),
    '/target/ci/test': sourceTarget({ command: rdk.one('/tester') }),
  })
}

export function eslint({ prettier: enforceFormatting = false, explicitReturnTypes = false } = {}) {
  const packages = [
    '@eslint/js',
    '@typescript-eslint/eslint-plugin',
    '@typescript-eslint/parser',
    'eslint',
    ...(enforceFormatting ? ['eslint-plugin-prettier', 'prettier'] : []),
  ]
  return rdk.graph({
    '/eslint/config': file({ source: rdk.one('/source/directory') }, {
      for: ['dev', 'lint'],
      render(_context, { source }) {
        const rules = {
          'no-undef': 'off',
          'no-redeclare': 'off',
          'no-dupe-class-members': 'off',
          '@typescript-eslint/no-empty-object-type': 'off',
          '@typescript-eslint/no-unused-vars': 'error',
          ...(explicitReturnTypes ? { '@typescript-eslint/explicit-function-return-type': 'error' } : {}),
          ...(enforceFormatting ? { 'prettier/prettier': 'error' } : {}),
        }
        return writeText('/repo/eslint.config.mjs', `import js from '@eslint/js'
import parser from '@typescript-eslint/parser'
import plugin from '@typescript-eslint/eslint-plugin'
${enforceFormatting ? "import prettier from 'eslint-plugin-prettier'\n" : ''}export default [
  js.configs.recommended,
  {
    files: ${JSON.stringify([`${source}/**/*.ts`, `${source}/**/*.tsx`])},
    languageOptions: { parser, parserOptions: { project: './tsconfig.json' } },
    plugins: { '@typescript-eslint': plugin${enforceFormatting ? ', prettier' : ''} },
    rules: { ...plugin.configs.recommended.rules, ...${JSON.stringify(rules)} },
  },
  {
    files: ${JSON.stringify([
      `${source}/**/*.test.ts`, `${source}/**/*.spec.ts`,
      `${source}/**/*.test.tsx`, `${source}/**/*.spec.tsx`,
    ])},
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
]
`)
      },
    }),
    '/eslint/config/hoisted': adapter('/eslint/config'),
    '/eslint/tooling': tooling({ for: ['dev', 'lint'], packages }),
    '/eslint/package-json/dependencies': packageJsonDependencies('/eslint/tooling'),
    '/eslint/linter': command({}, {
      for: ['lint'],
      files: rdk.many(
        '/typescript/tsconfig',
        '/eslint/config',
        ...(enforceFormatting ? ['/prettier/config'] : []),
      ),
      run: () => ({ tool: 'eslint .' }),
    }),
    '/linter': adapter('/eslint/linter'),
    '/linter/package-json/script': adapter('/eslint/linter'),
    '/target/ci/lint': sourceTarget({ command: rdk.one('/linter') }),
  })
}

const rollupConfig = (input, output, strict) => `import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import { builtinModules } from 'node:module'

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => \`node:\${name}\`),
])

export default {
  input: ${JSON.stringify(input)},
  external: (id) => builtins.has(id),
  plugins: [nodeResolve({ preferBuiltins: true }), commonjs()],${strict ? `
  onLog(level, log, handler) {
    if (log.code === 'CIRCULAR_DEPENDENCY') return
    if (level === 'warn') handler('error', log)
    else handler(level, log)
  },` : ''}
  output: {
    file: ${JSON.stringify(output)},
    format: 'esm',
  },
}
`

/**
 * Bundles a compiled library into one JavaScript file, treating node builtins as external. Its own
 * `bundle` intent keeps the config and the bundler out of the compile target that feeds it.
 */
export function rollup({ bundleDirectory = 'dist', strict = true } = {}) {
  return rdk.graph({
    '/output/bundle-directory': rdk.value(bundleDirectory),
    '/output/bundle-file': rdk.derive(
      { directory: rdk.one('/output/bundle-directory'), slug: rdk.one('/package/slug') },
      ({ directory, slug }) => `${directory}/${slug}.js`,
    ),
    '/rollup/tooling': tooling({
      packages: ['@rollup/plugin-commonjs', '@rollup/plugin-node-resolve', 'rollup'],
    }),
    '/rollup/package-json/dependencies': packageJsonDependencies('/rollup/tooling'),
    '/rollup/config': file({
      output: rdk.one('/output/layout'),
      bundleFile: rdk.one('/output/bundle-file'),
    }, {
      for: ['bundle'],
      render(_context, { output, bundleFile }) {
        if (output?.runtimeFile === undefined) {
          throw new Error('rollup() needs a product that emits JavaScript, such as library()')
        }
        return writeText('/repo/rollup.config.js', rollupConfig(output.runtimeFile, bundleFile, strict))
      },
    }),
    '/rollup/bundler': command({}, {
      for: ['bundle'],
      files: rdk.many('/rollup/config'),
      run: () => ({ tool: 'rollup --config rollup.config.js' }),
    }),
    '/bundler': adapter('/rollup/bundler'),
    '/target/ci/bundle': target({
      ignore: rdk.one('/source/ignore'),
      exec: rdk.one('/package-manager/exec'),
      bundleFile: rdk.one('/output/bundle-file'),
      bundler: rdk.one('/bundler'),
    }, {
      render: (context, { ignore, exec, bundleFile, bundler }) => ({
        deps: ['build'],
        run: ({ images }) => ({
          FROM: images.build,
          steps: [...context.files(bundler.files), ...runSteps(bundler.invocations, exec)],
          IGNORE: ignore,
          EXPORT: { [`/repo/${bundleFile}`]: bundleFile },
        }),
      }),
    }),
  })
}

export function typedoc({ title } = {}) {
  return rdk.graph({
    '/typedoc/config': file({
      source: rdk.one('/source/directory'),
      entry: rdk.one('/source/entry'),
      name: rdk.one('/package/name'),
      product: rdk.one('/product/kind'),
    }, {
      for: ['dev', 'docs'],
      render(context, { source, entry, name, product }) {
        const includeTests = product !== 'library' || ['dev', 'test', 'lint'].includes(context.intent)
        return writeJson('/repo/typedoc.json', {
          entryPoints: [`${source}/${entry}`],
          name: title ?? name,
          includeVersion: true,
          excludeExternals: true,
          excludePrivate: true,
          excludeProtected: true,
          exclude: includeTests ? [] : [`${source}/**/*.test.ts`, `${source}/**/*.spec.ts`],
        })
      },
    }),
    '/typedoc/config/hoisted': adapter('/typedoc/config'),
    '/typedoc/tooling': tooling({
      for: ['dev', 'docs'],
      packages: ['typedoc'],
    }),
    '/typedoc/package-json/dependencies': packageJsonDependencies('/typedoc/tooling'),
    '/typedoc/documenter': command({}, {
      for: ['docs'],
      files: rdk.many('/typescript/tsconfig', '/typedoc/config'),
      run: () => ({ tool: 'typedoc' }),
    }),
    '/documenter': adapter('/typedoc/documenter'),
    '/documenter/package-json/script': adapter('/typedoc/documenter'),
    '/target/ci/docs': sourceTarget({
      command: rdk.one('/documenter'),
      export: { '/repo/docs/': 'docs/' },
    }),
  })
}
