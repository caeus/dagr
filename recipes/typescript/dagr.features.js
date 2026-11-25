import bundledVersions from '//dagr.versions.yaml'
import { value, derive, select, scope, packageNodes } from '//dagr.nodes.js'
import { command, file, copyFiles, target } from '//dagr.contributions.js'
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
    if ('target' in dependency && (typeof dependency.name !== 'string' || !dependency.name))
      throw new Error('Local package dependencies must name the npm package')
    const sources = ['target', 'npm'].filter(source => source in dependency)
    if (sources.length !== 1) {
      throw new Error(`${name}: dependency needs exactly one of target or npm`)
    }
    if (!['prod', 'dev'].includes(dependency.at)) {
      throw new Error(`${name}: dependency ${dependency.target ?? dependency.npm} needs at prod or dev`)
    }
    const entry = 'target' in dependency
      ? [dependency.name, '>=0.0.0']
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
const packageFacts = derive(
  {
    name: '/package/name',
    version: '/package/version',
    deps: '/package/dependencies',
    metadata: '/package/metadata',
    scope: '/package/scope',
    format: '/javascript/module-format',
    product: '/product/kind',
    source: '/source/directory',
    entry: '/source/entry',
    output: '/output/layout',
    alias: '/source/import-alias',
    runtime: '/package/runtime-dependencies',
  },
  facts => Object.freeze({ ...facts }),
)

const packageJson = file('/repo/package.json',
  {
    facts: '/package/facts',
    dependencies: select('/**/package-json/dependencies'),
    configuredVersions: '/version/catalog',
    installManifest: '/package-manager/install-manifest',
    localPackages: '/package/local-dependencies',
    scripts: '/package/scripts',
  },
  {
    for: [...DEVELOPMENT_INTENTS, ...DISTRIBUTION_INTENTS],
    render(context, { facts, dependencies, configuredVersions, installManifest, localPackages, scripts }) {
      const packages = packagesFor(dependencies, context, configuredVersions)
      const manifest = packageManifest(context, facts, { packages }, configuredVersions, scripts)
      return writeJson('/repo/package.json',
        DISTRIBUTION_INTENTS.includes(context.intent) ? manifest : installManifest(manifest, localPackages, context))
    },
  },
)

const tsconfig = file('/repo/tsconfig.json',
  {
    product: '/product/kind',
    language: '/typescript/language-target',
    sourceMaps: '/output/source-maps',
    emitDeclarations: '/typescript/emit-declarations',
    source: '/source/directory',
    output: '/output/layout',
    module: '/typescript/module-kind',
    moduleResolution: '/typescript/module-resolution',
    libraries: '/typescript/libraries',
    alias: '/source/import-alias',
    types: select('/**/tsconfig/types'),
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

/** Every source build copies the exact files it consumes from their generating images. */
export const sourceTarget = ({ intent, command, files = [], assets = false, export: exported } = {}) => {
  if (!intent) throw new Error('sourceTarget requires an intent')
  return target({
    base: '/image/base',
    ignore: '/source/ignore',
    source: '/source/directory',
    localPackages: '/package/local-dependencies',
    localImages: '/package/local-images',
    exec: '/package-manager/exec',
    install: '/package-manager/install',
    files: select(
      `/file/${intent}/package.json`,
      `/file/${intent}/package-manager/**`,
      ...files.map(path => `/file/${intent}/${path}`),
    ),
    ...(command === undefined ? {} : { command }),
    ...(assets ? { buildAssets: '/source/assets' } : {}),
  }, {
    intent,
    render(context, { base, ignore, source, localPackages, localImages, exec, install, files, command, buildAssets = [] }) {
      return {
        FROM: base,
        steps: [
          ...copyLocalPackages(localPackages, localImages),
          copySource(source),
          ...copyAssets(buildAssets),
          { WORKDIR: '/repo' },
          ...copyFiles(files),
          { RUN: install() },
          ...(command === undefined ? [] : runSteps(command.invocations, exec)),
        ],
        IGNORE: ignore,
        ...(exported === undefined ? {} : { EXPORT: exported }),
      }
    },
  })
}

/** Host materialization is an explicit build with EXPORT. */
export function hoister(name) {
  return scope(name, {
    '/dev/hoist': target({
      base: '/image/base',
      ignore: '/source/ignore',
      localPackages: '/package/local-dependencies',
      localImages: '/package/local-images',
      files: select('/file/dev/**'),
    }, {
      intent: 'dev',
      render(_context, { base, ignore, localPackages, localImages, files }) {
        return {
          FROM: base,
          steps: [
            ...copyLocalPackages(localPackages, localImages),
            { WORKDIR: '/repo' },
            ...copyFiles(files),
          ],
          IGNORE: ignore,
          EXPORT: { '/repo/': './' },
        }
      },
    }),
  })
}

/** Common facts and the two universal generated files. All values are ordinary Dagr nodes. */
export function typescript(name, {
  base = '/node-base',
  location,
  packageName,
  version = '0.1.0',
  deps = [],
  metadata = {},
  scope: packageScope = 'internal',
  versions = {},
  sourceDirectory = 'src',
  entryFile = 'index.ts',
  outputDirectory = 'dist',
  javascriptModuleFormat = 'esm',
  ignore = RECOMMENDED_IGNORE,
} = {}) {
  if (!base) throw new Error('typescript() requires a base target')
  return scope(name, {
    ...packageNodes({ location, version, deps, metadata }),
    '/image/base': derive({ image: base }, ({ image }) => image),
    '/source/ignore': value(ignore),
    '/package/scope': value(packageScope),
    '/version/catalog': value(Object.freeze({ ...bundledVersions.deps, ...versions })),
    '/source/directory': value(sourceDirectory),
    '/source/entry': value(entryFile),
    '/output/directory': value(outputDirectory),
    '/javascript/module-format': value(javascriptModuleFormat),
    '/typescript/emit-declarations': value(true),
    '/package/name': value(packageName ?? `@${packageScope}/${name}`),
    '/package/slug': derive(
      { name: '/package/name' },
      ({ name }) => name.slice(name.indexOf('/') + 1),
    ),
    '/source/layout': derive(
      { directory: '/source/directory', entry: '/source/entry' },
      ({ directory, entry }) => ({ directory, entry }),
    ),
    '/output/layout': derive(
      {
        product: '/product/kind',
        directory: '/output/directory',
        entry: '/source/entry',
      },
      ({ product, directory, entry }) => {
        if (product === 'worker') return undefined
        if (product === 'web') return { directory }
        const stem = entry.replace(/\.[^.]+$/, '')
        return { directory, runtimeFile: `${directory}/${stem}.js`, declarationFile: `${directory}/${stem}.d.ts` }
      },
    ),
    '/package/local-dependencies': derive(
      { dependencies: '/package/dependencies' },
      ({ dependencies }) => localPackagesOf(dependencies),
    ),
    '/package/scripts': derive(
      { commands: select('/**/package-json/script'), script: '/package-manager/script' },
      ({ commands, script }) => scriptsFor(commands, script),
    ),
    '/package/facts': packageFacts,
    ...packageJson,
    ...tsconfig,
  })
}

const typescriptPackages = runtime => [
  '@tsconfig/strictest',
  'typescript',
  ...(runtime === 'node' ? ['@types/node'] : []),
]

export function library(name, {
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
  return scope(name, {
    '/product/kind': value('library'),
    '/runtime/kind': value(runtime),
    '/typescript/language-target': value(language),
    '/output/source-maps': value(sourceMaps),
    '/source/assets': value(Object.freeze([...assets])),
    '/package/runtime-dependencies': value(Object.freeze([])),
    '/typescript/module-kind': value(runtime === 'node' ? 'NodeNext' : 'ESNext'),
    '/typescript/module-resolution': value(runtime === 'node' ? 'NodeNext' : 'Bundler'),
    '/typescript/libraries': value(Object.freeze([language])),
    '/source/import-alias': value(undefined),
    '/library/tooling': tooling({
      packages,
      types,
    }),
    '/library/package-json/dependencies': packageJsonDependencies('/library/tooling'),
    '/library/tsconfig/types': tsconfigTypes('/library/tooling'),
    '/typescript/typechecker': command({}, {
      for: ['typecheck'],
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    '/typescript/typechecker/package-json/script': adapter('/typescript/typechecker'),
    '/typescript/compiler': command({}, {
      for: ['build'],
      run: () => ({ tool: 'tsc' }),
    }),
    '/typescript/compiler/package-json/script': adapter('/typescript/compiler'),
    '/typecheck': sourceTarget({ intent: 'typecheck', command: '/typescript/typechecker', files: ['tsconfig.json'] }),
    '/build': sourceTarget({ intent: 'build', command: '/typescript/compiler', files: ['tsconfig.json'], assets: true }),
    '/pack': target(
      {
        ignore: '/source/ignore',
        localPackages: '/package/local-dependencies',
        localImages: '/package/local-images',
        base: '/build',
        pack: '/package-manager/pack',
        slug: '/package/slug',
        manifest: '/file/pack/package.json',
      },
      {
        render(context, { ignore, localPackages, localImages, base, pack, slug, manifest }) {
          return {
              FROM: base,
              steps: [
                ...copyLocalPackages(localPackages, localImages, '/out'),
                { WORKDIR: '/repo' },
                ...copyFiles({ manifest }),
                { RUN: pack(slug) },
              ],
              IGNORE: ignore,
              path: '/out',
          }
        },
      },
    ),
    '/publish/pack': target(
      {
        ignore: '/source/ignore',
        localPackages: '/package/local-dependencies',
        localImages: '/package/local-images',
        base: '/build',
        pack: '/package-manager/pack',
        slug: '/package/slug',
        manifest: '/file/publish/package.json',
      },
      {
        intent: 'publish',
        render(context, { ignore, localPackages, localImages, base, pack, slug, manifest }) {
          return {
              FROM: base,
              steps: [
                ...copyLocalPackages(localPackages, localImages, '/out'),
                { WORKDIR: '/repo' },
                ...copyFiles({ manifest }),
                { RUN: pack(slug) },
              ],
              IGNORE: ignore,
              path: '/out',
          }
        },
      },
    ),
  })
}

export function cloudflareWorker(name, { language = 'ES2022' } = {}) {
  const packages = [...typescriptPackages('portable'), '@cloudflare/workers-types', 'wrangler']
  return scope(name, {
    '/product/kind': value('worker'),
    '/runtime/kind': value('cloudflare-worker'),
    '/typescript/language-target': value(language),
    '/output/source-maps': value(false),
    '/source/assets': value(Object.freeze([])),
    '/package/runtime-dependencies': value(Object.freeze([])),
    '/typescript/module-kind': value('NodeNext'),
    '/typescript/module-resolution': value('NodeNext'),
    '/typescript/libraries': value(Object.freeze([language])),
    '/source/import-alias': derive(
      { source: '/source/directory' },
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
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    '/typescript/typechecker/package-json/script': adapter('/typescript/typechecker'),
    '/typecheck': sourceTarget({ intent: 'typecheck', command: '/typescript/typechecker', files: ['tsconfig.json'] }),
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

export function viteReact(name, { language = 'ES2020' } = {}) {
  const packages = [...typescriptPackages('node'), 'vite']
  return scope(name, {
    '/product/kind': value('web'),
    '/runtime/kind': value('browser'),
    '/typescript/language-target': value(language),
    '/output/source-maps': value(false),
    '/source/assets': value(Object.freeze(['index.html', 'public'])),
    '/package/runtime-dependencies': value(viteRuntimePackages),
    '/typescript/module-kind': value('ESNext'),
    '/typescript/module-resolution': value('Bundler'),
    '/typescript/libraries': value(Object.freeze([language, 'DOM', 'DOM.Iterable'])),
    '/source/import-alias': derive(
      { source: '/source/directory' },
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
    ...file('/repo/vite.config.ts', { source: '/source/directory' }, {
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
    '/typescript/typechecker': command({}, {
      for: ['typecheck'],
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    '/typescript/typechecker/package-json/script': adapter('/typescript/typechecker'),
    '/vite/compiler': command({}, {
      for: ['build'],
      run: () => ({ tool: 'vite build' }),
    }),
    '/typescript/compiler': adapter('/vite/compiler'),
    '/typescript/compiler/package-json/script': adapter('/typescript/compiler'),
    '/typecheck': sourceTarget({ intent: 'typecheck', command: '/typescript/typechecker', files: ['tsconfig.json'] }),
    '/build': sourceTarget({ intent: 'build', command: '/typescript/compiler', files: ['tsconfig.json', 'vite.config.ts'], assets: true }),
  })
}

export function prettier(name, {
  semi = false,
  tabWidth = 2,
  singleQuote = true,
  printWidth = 100,
  trailingComma = 'none',
} = {}) {
  return scope(name, {
    '/prettier/tooling': tooling({
      for: ['dev'],
      packages: ['prettier'],
    }),
    '/prettier/package-json/dependencies': packageJsonDependencies('/prettier/tooling'),
    ...file('/repo/.prettierrc.json', {}, {
      key: 'prettierrc.json',
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
  })
}

export function biome(name, { formatter = true, linter = true } = {}) {
  return scope(name, {
    ...file('/repo/biome.json', {}, {
      for: ['dev', 'lint'],
      render: () => writeJson('/repo/biome.json', {
        formatter: { enabled: formatter },
        linter: { enabled: linter },
      }),
    }),
    '/biome/tooling': tooling({
      for: ['dev', 'lint'],
      packages: ['@biomejs/biome'],
    }),
    '/biome/package-json/dependencies': packageJsonDependencies('/biome/tooling'),
    ...(linter ? {
      '/biome/linter': command({}, {
        for: ['lint'],
        run: () => ({ tool: 'biome check .' }),
      }),
      '/typescript/linter': adapter('/biome/linter'),
      '/typescript/linter/package-json/script': adapter('/typescript/linter'),
      '/lint': sourceTarget({ intent: 'lint', command: '/typescript/linter', files: ['biome.json'] }),
    } : {}),
  })
}

export function vitest(name, { environment = 'node', globals = false, typecheck = false } = {}) {
  return scope(name, {
    ...file('/repo/vitest.config.ts', {}, {
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
      run: () => ({ tool: 'vitest run' }),
    }),
    '/typescript/tester': adapter('/vitest/tester'),
    '/typescript/tester/package-json/script': adapter('/typescript/tester'),
    '/test': sourceTarget({ intent: 'test', command: '/typescript/tester', files: ['tsconfig.json', 'vitest.config.ts', ...(environment === 'jsdom' ? ['vite.config.ts'] : [])] }),
  })
}

export function eslint(name, { prettier: enforceFormatting = false, explicitReturnTypes = false } = {}) {
  const packages = [
    '@eslint/js',
    '@typescript-eslint/eslint-plugin',
    '@typescript-eslint/parser',
    'eslint',
    ...(enforceFormatting ? ['eslint-plugin-prettier', 'prettier'] : []),
  ]
  return scope(name, {
    ...file('/repo/eslint.config.mjs', { source: '/source/directory' }, {
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
    '/eslint/tooling': tooling({ for: ['dev', 'lint'], packages }),
    '/eslint/package-json/dependencies': packageJsonDependencies('/eslint/tooling'),
    '/eslint/linter': command({}, {
      for: ['lint'],
      run: () => ({ tool: 'eslint .' }),
    }),
    '/typescript/linter': adapter('/eslint/linter'),
    '/typescript/linter/package-json/script': adapter('/typescript/linter'),
    '/lint': sourceTarget({ intent: 'lint', command: '/typescript/linter', files: ['tsconfig.json', 'eslint.config.mjs', ...(enforceFormatting ? ['prettierrc.json'] : [])] }),
  })
}

const rollupConfig = (input, output, strict) => `import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import { builtinModules } from 'node:module'

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => 'node:' + name),
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
export function rollup(name, { bundleDirectory = 'dist', strict = true } = {}) {
  return scope(name, {
    '/output/bundle-directory': value(bundleDirectory),
    '/output/bundle-file': derive(
      { directory: '/output/bundle-directory', slug: '/package/slug' },
      ({ directory, slug }) => `${directory}/${slug}.js`,
    ),
    '/rollup/tooling': tooling({
      packages: ['@rollup/plugin-commonjs', '@rollup/plugin-node-resolve', 'rollup'],
    }),
    '/rollup/package-json/dependencies': packageJsonDependencies('/rollup/tooling'),
    ...file('/repo/rollup.config.js', {
      output: '/output/layout',
      bundleFile: '/output/bundle-file',
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
      run: () => ({ tool: 'rollup --config rollup.config.js' }),
    }),
    '/typescript/bundler': adapter('/rollup/bundler'),
    '/bundle': target({
      ignore: '/source/ignore',
      exec: '/package-manager/exec',
      bundleFile: '/output/bundle-file',
      bundler: '/typescript/bundler',
      config: '/file/bundle/rollup.config.js',
      base: '/build',
    }, {
      render: (_context, { ignore, exec, bundleFile, bundler, config, base }) => ({
          FROM: base,
          steps: [...copyFiles({ config }), ...runSteps(bundler.invocations, exec)],
          IGNORE: ignore,
          EXPORT: { [`/repo/${bundleFile}`]: bundleFile },
      }),
    }),
  })
}

export function typedoc(name, { title } = {}) {
  return scope(name, {
    ...file('/repo/typedoc.json', {
      source: '/source/directory',
      entry: '/source/entry',
      name: '/package/name',
      product: '/product/kind',
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
    '/typedoc/tooling': tooling({
      for: ['dev', 'docs'],
      packages: ['typedoc'],
    }),
    '/typedoc/package-json/dependencies': packageJsonDependencies('/typedoc/tooling'),
    '/typedoc/documenter': command({}, {
      for: ['docs'],
      run: () => ({ tool: 'typedoc' }),
    }),
    '/typescript/documenter': adapter('/typedoc/documenter'),
    '/typescript/documenter/package-json/script': adapter('/typescript/documenter'),
    '/docs': sourceTarget({
      intent: 'docs',
      command: '/typescript/documenter',
      files: ['tsconfig.json', 'typedoc.json'],
      export: { '/repo/docs/': 'docs/' },
    }),
  })
}
