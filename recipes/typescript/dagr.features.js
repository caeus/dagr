import bundledVersions from '//dagr.versions.yaml'
import { value, derive, select } from '//dagr.nodes.js'
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
  projectReference,
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
    const sources = ['target', 'npm'].filter(source => source in dependency)
    if (sources.length !== 1) {
      throw new Error(`${name}: dependency needs exactly one of facet or npm`)
    }
    if (!['prod', 'dev'].includes(dependency.at)) {
      throw new Error(`${name}: dependency ${dependency.target ?? dependency.npm} needs at prod or dev`)
    }
    const entry = 'target' in dependency
      ? [projectName(projectReference(dependency.target).pkg, scope), '>=0.0.0']
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

const packageJson = file(
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
      return writeJson(
        '/repo/package.json',
        context.install ? installManifest(manifest, localPackages, context) : manifest,
      )
    },
  },
)

const tsconfig = file(
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
      base: '/image/base',
      ignore: '/source/ignore',
      source: '/source/directory',
      localPackages: '/package/local-dependencies',
      localImages: '/package/local-images',
      exec: '/package-manager/exec',
      install: '/package-manager/install',
      files: select(
        '/typescript/package-json',
        '/package-manager/config',
        ...files,
      ),
      ...(commandInput === undefined ? {} : { command: commandInput }),
      ...(assets ? { buildAssets: '/source/assets' } : {}),
    },
    {
      intent,
      render(context, values) {
        const {
          base, ignore, source, localPackages, localImages, exec, install, files: targetFiles,
          command: selected, buildAssets = [],
        } = values
        return {
            FROM: base,
            steps: [
              ...copyLocalPackages(localPackages, localImages),
              copySource(source),
              ...copyAssets(buildAssets),
              { WORKDIR: '/repo' },
              ...context.files({ ...targetFiles, ...(selected?.files ?? {}) }, { install: true }),
              { RUN: install() },
              ...(selected === undefined ? [] : runSteps(selected.invocations, exec)),
            ],
            IGNORE: ignore,
            ...(exported === undefined ? {} : { EXPORT: exported }),
        }
      },
    },
  )
}

/** Materializes every structurally hoisted file contribution onto the host. */
export function hoister() {
  return ({
    '/target/dev/hoist': target(
      {
        base: '/image/base',
        ignore: '/source/ignore',
        localPackages: '/package/local-dependencies',
        localImages: '/package/local-images',
        hoisted: select('/**/hoisted', '/**/hoisted/*'),
      },
      {
        intent: 'dev',
        render(context, { base, ignore, localPackages, localImages, hoisted }) {
          return {
              FROM: base,
              steps: [
                ...copyLocalPackages(localPackages, localImages),
                { WORKDIR: '/repo' },
                ...filesFor(hoisted, {
                  intent: context.intent,
                  facet: context.facet,
                  host: context.host,
                  install: true,
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
  return ({
    '/image/base': derive({ image: base }, ({ image }) => image),
    '/source/ignore': value(ignore),
    '/package/scope': value(scope),
    '/version/catalog': value(Object.freeze({ ...bundledVersions.deps, ...versions })),
    '/source/directory': value(sourceDirectory),
    '/source/entry': value(entryFile),
    '/output/directory': value(outputDirectory),
    '/javascript/module-format': value(javascriptModuleFormat),
    '/typescript/emit-declarations': value(true),
    '/package/name': derive(
      { location: '/package/location', scope: '/package/scope' },
      ({ location, scope: packageScope }) => projectName(location, packageScope),
    ),
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
      { dependencies: '/package/dependencies', scope: '/package/scope' },
      ({ dependencies, scope: packageScope }) => localPackagesOf(dependencies, packageScope),
    ),
    '/package/scripts': derive(
      { commands: select('/**/package-json/script'), script: '/package-manager/script' },
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
  return ({
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
    '/typescript/typechecker': command({ files: select('/typescript/tsconfig') }, {
      for: ['typecheck'],
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    '/typescript/typechecker/package-json/script': adapter('/typescript/typechecker'),
    '/typescript/compiler': command({ files: select('/typescript/tsconfig') }, {
      for: ['build'],
      run: () => ({ tool: 'tsc' }),
    }),
    '/typescript/compiler/package-json/script': adapter('/typescript/compiler'),
    '/target/ci/typecheck': sourceTarget({ command: '/typescript/typechecker' }),
    '/target/ci/build': sourceTarget({ command: '/typescript/compiler', assets: true }),
    '/target/ci/pack': target(
      {
        ignore: '/source/ignore',
        localPackages: '/package/local-dependencies',
        localImages: '/package/local-images',
        base: '/target/ci/build',
        pack: '/package-manager/pack',
        slug: '/package/slug',
        files: select('/typescript/package-json'),
      },
      {
        render(context, { ignore, localPackages, localImages, base, pack, slug, files }) {
          return {
              FROM: base,
              steps: [
                ...copyLocalPackages(localPackages, localImages, '/out'),
                { WORKDIR: '/repo' },
                ...context.files(files, { install: false }),
                { RUN: pack(slug) },
              ],
              IGNORE: ignore,
          }
        },
      },
    ),
    '/target/publish/pack': target(
      {
        ignore: '/source/ignore',
        localPackages: '/package/local-dependencies',
        localImages: '/package/local-images',
        base: '/target/ci/build',
        pack: '/package-manager/pack',
        slug: '/package/slug',
        files: select('/typescript/package-json'),
      },
      {
        intent: 'publish',
        render(context, { ignore, localPackages, localImages, base, pack, slug, files }) {
          return {
              FROM: base,
              steps: [
                ...copyLocalPackages(localPackages, localImages, '/out'),
                { WORKDIR: '/repo' },
                ...context.files(files, { install: false }),
                { RUN: pack(slug) },
              ],
              IGNORE: ignore,
          }
        },
      },
    ),
  })
}

export function cloudflareWorker({ language = 'ES2022' } = {}) {
  const packages = [...typescriptPackages('portable'), '@cloudflare/workers-types', 'wrangler']
  return ({
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
    '/typescript/typechecker': command({ files: select('/typescript/tsconfig') }, {
      for: ['typecheck'],
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    '/typescript/typechecker/package-json/script': adapter('/typescript/typechecker'),
    '/target/ci/typecheck': sourceTarget({ command: '/typescript/typechecker' }),
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
  return ({
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
    '/vite/config': file({ source: '/source/directory' }, {
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
    '/typescript/typechecker': command({ files: select('/typescript/tsconfig') }, {
      for: ['typecheck'],
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    '/typescript/typechecker/package-json/script': adapter('/typescript/typechecker'),
    '/vite/compiler': command({ files: select('/typescript/tsconfig', '/vite/config') }, {
      for: ['build'],
      run: () => ({ tool: 'vite build' }),
    }),
    '/typescript/compiler': adapter('/vite/compiler'),
    '/typescript/compiler/package-json/script': adapter('/typescript/compiler'),
    '/target/ci/typecheck': sourceTarget({ command: '/typescript/typechecker' }),
    '/target/ci/build': sourceTarget({ command: '/typescript/compiler', assets: true }),
  })
}

export function prettier({
  semi = false,
  tabWidth = 2,
  singleQuote = true,
  printWidth = 100,
  trailingComma = 'none',
} = {}) {
  return ({
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
  return ({
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
      '/biome/linter': command({ files: select('/biome/config') }, {
        for: ['lint'],
        run: () => ({ tool: 'biome check .' }),
      }),
      '/typescript/linter': adapter('/biome/linter'),
      '/typescript/linter/package-json/script': adapter('/typescript/linter'),
      '/target/ci/lint': sourceTarget({ command: '/typescript/linter' }),
    } : {}),
  })
}

export function vitest({ environment = 'node', globals = false, typecheck = false } = {}) {
  const configDeps = environment === 'jsdom'
    ? { viteConfig: '/vite/config' }
    : {}
  return ({
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
    '/vitest/tester': command({
      files: select(
        '/typescript/tsconfig',
        '/vitest/config',
        ...(environment === 'jsdom' ? ['/vite/config'] : []),
      ),
    }, {
      for: ['test'],
      run: () => ({ tool: 'vitest run' }),
    }),
    '/typescript/tester': adapter('/vitest/tester'),
    '/typescript/tester/package-json/script': adapter('/typescript/tester'),
    '/target/ci/test': sourceTarget({ command: '/typescript/tester' }),
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
  return ({
    '/eslint/config': file({ source: '/source/directory' }, {
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
    '/eslint/linter': command({
      files: select(
        '/typescript/tsconfig',
        '/eslint/config',
        ...(enforceFormatting ? ['/prettier/config'] : []),
      ),
    }, {
      for: ['lint'],
      run: () => ({ tool: 'eslint .' }),
    }),
    '/typescript/linter': adapter('/eslint/linter'),
    '/typescript/linter/package-json/script': adapter('/typescript/linter'),
    '/target/ci/lint': sourceTarget({ command: '/typescript/linter' }),
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
export function rollup({ bundleDirectory = 'dist', strict = true } = {}) {
  return ({
    '/output/bundle-directory': value(bundleDirectory),
    '/output/bundle-file': derive(
      { directory: '/output/bundle-directory', slug: '/package/slug' },
      ({ directory, slug }) => `${directory}/${slug}.js`,
    ),
    '/rollup/tooling': tooling({
      packages: ['@rollup/plugin-commonjs', '@rollup/plugin-node-resolve', 'rollup'],
    }),
    '/rollup/package-json/dependencies': packageJsonDependencies('/rollup/tooling'),
    '/rollup/config': file({
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
    '/rollup/bundler': command({ files: select('/rollup/config') }, {
      for: ['bundle'],
      run: () => ({ tool: 'rollup --config rollup.config.js' }),
    }),
    '/typescript/bundler': adapter('/rollup/bundler'),
    '/target/ci/bundle': target({
      ignore: '/source/ignore',
      exec: '/package-manager/exec',
      bundleFile: '/output/bundle-file',
      bundler: '/typescript/bundler',
      base: '/target/ci/build',
    }, {
      render: (context, { ignore, exec, bundleFile, bundler, base }) => ({
          FROM: base,
          steps: [...context.files(bundler.files), ...runSteps(bundler.invocations, exec)],
          IGNORE: ignore,
          EXPORT: { [`/repo/${bundleFile}`]: bundleFile },
      }),
    }),
  })
}

export function typedoc({ title } = {}) {
  return ({
    '/typedoc/config': file({
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
    '/typedoc/config/hoisted': adapter('/typedoc/config'),
    '/typedoc/tooling': tooling({
      for: ['dev', 'docs'],
      packages: ['typedoc'],
    }),
    '/typedoc/package-json/dependencies': packageJsonDependencies('/typedoc/tooling'),
    '/typedoc/documenter': command({ files: select('/typescript/tsconfig', '/typedoc/config') }, {
      for: ['docs'],
      run: () => ({ tool: 'typedoc' }),
    }),
    '/typescript/documenter': adapter('/typedoc/documenter'),
    '/typescript/documenter/package-json/script': adapter('/typescript/documenter'),
    '/target/ci/docs': sourceTarget({
      command: '/typescript/documenter',
      export: { '/repo/docs/': 'docs/' },
    }),
  })
}
