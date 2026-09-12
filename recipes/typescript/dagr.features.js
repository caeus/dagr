import bundledVersions from '//dagr.versions.yaml'
import rdk from 'dagr:rdk'
import { command, fact, file, filesFor, target } from '//dagr.contributions.js'
import { writeJson, writeText } from '//dagr.file-utils.js'
import { RECOMMENDED_IGNORE } from '//dagr.dockerignore.js'
import {
  DEVELOPMENT_INTENTS,
  DISTRIBUTION_INTENTS,
  copyAssets,
  copyLocalPackages,
  copySource,
  localPackagesOf,
  present,
  projectName,
  requirement,
  requirementsOf,
  runSteps,
  scriptsFor,
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
    requirements: rdk.many('/requirement/*'),
    configuredVersions: rdk.one('/version/catalog'),
    installManifest: rdk.one('/package-manager/install-manifest'),
    localPackages: rdk.one('/package/local-dependencies'),
    scripts: rdk.one('/package/scripts'),
  },
  {
    for: [...DEVELOPMENT_INTENTS, ...DISTRIBUTION_INTENTS],
    render(context, { facts, requirements, configuredVersions, installManifest, localPackages, scripts }) {
      const tooling = requirementsOf(requirements, context, configuredVersions)
      const manifest = packageManifest(context, facts, tooling, configuredVersions, scripts)
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
    requirements: rdk.many('/requirement/*'),
    versions: rdk.one('/version/catalog'),
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
      requirements,
      versions,
    }) {
      const emitting = product === 'library' && ['build', 'pack', 'publish'].includes(context.intent)
      const includeTests = product !== 'library' || ['dev', 'test', 'lint'].includes(context.intent)
      const types = requirementsOf(requirements, context, versions).types
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
 * A target that builds the package from its own sources: local tarballs, the source tree, the files
 * the context contributes, then the intent's invocations. Installation is structural here rather
 * than a contribution, because only a fresh image needs it.
 */
export const sourceTarget = ({ intent, assets = false, export: exported } = {}) => target(
  {
    base: rdk.one('/image/base'),
    ignore: rdk.one('/source/ignore'),
    source: rdk.one('/source/directory'),
    localPackages: rdk.one('/package/local-dependencies'),
    exec: rdk.one('/package-manager/exec'),
    install: rdk.one('/package-manager/install'),
    ...(assets ? { buildAssets: rdk.one('/source/assets') } : {}),
  },
  {
    intent,
    render(context, { base, ignore, source, localPackages, exec, install, buildAssets = [] }) {
      return {
        deps: [base, ...localPackages.map(pkg => pkg.target)],
        run: ({ images }) => ({
          FROM: images[base],
          steps: [
            ...copyLocalPackages(localPackages, images),
            copySource(source),
            ...copyAssets(buildAssets),
            { WORKDIR: '/repo' },
            ...context.files({ install: true }),
            { RUN: install() },
            ...runSteps(context.invocations(), exec),
          ],
          IGNORE: ignore,
          ...(exported === undefined ? {} : { EXPORT: exported }),
        }),
      }
    },
  },
)

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
      { commands: rdk.many('/command/**'), script: rdk.one('/package-manager/script') },
      ({ commands, script }) => scriptsFor(commands, script),
    ),
    '/package/facts': packageFacts,
    '/file/package-json/hoisted': packageJson,
    '/file/tsconfig/hoisted': tsconfig,
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
    '/requirement/typescript': requirement({
      packages,
      types,
    }),
    '/command/typecheck/typescript': command({ requirement: rdk.one('/requirement/typescript') }, {
      for: ['typecheck'],
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    '/command/build/typescript': command({ requirement: rdk.one('/requirement/typescript') }, {
      for: ['build'],
      run: () => ({ tool: 'tsc' }),
    }),
    '/target/ci/typecheck': sourceTarget(),
    '/target/ci/build': sourceTarget({ assets: true }),
    '/target/ci/pack': target(
      {
        ignore: rdk.one('/source/ignore'),
        localPackages: rdk.one('/package/local-dependencies'),
        exec: rdk.one('/package-manager/exec'),
      },
      {
        render(context, { ignore, localPackages, exec }) {
          return {
            deps: ['build', ...localPackages.map(pkg => pkg.target)],
            run: ({ images }) => ({
              FROM: images.build,
              steps: [
                ...copyLocalPackages(localPackages, images, '/out'),
                { WORKDIR: '/repo' },
                ...context.files({ install: false }),
                ...runSteps(context.invocations(), exec),
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
        exec: rdk.one('/package-manager/exec'),
      },
      {
        intent: 'publish',
        render(context, { ignore, localPackages, exec }) {
          return {
            deps: ['ci:build', ...localPackages.map(pkg => pkg.target)],
            run: ({ images }) => ({
              FROM: images['ci:build'],
              steps: [
                ...copyLocalPackages(localPackages, images, '/out'),
                { WORKDIR: '/repo' },
                ...context.files({ install: false }),
                ...runSteps(context.invocations(), exec),
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
    '/requirement/typescript': requirement({
      packages,
      types: ['@cloudflare/workers-types'],
    }),
    '/requirement/build-scripts/typescript': fact({}, {
      for: DEVELOPMENT_INTENTS,
      value: ['sharp', 'workerd'],
    }),
    '/command/typecheck/typescript': command({ requirement: rdk.one('/requirement/typescript') }, {
      for: ['typecheck'],
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    '/target/ci/typecheck': sourceTarget(),
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
    '/requirement/typescript': requirement({
      packages,
      types: ['node'],
    }),
    '/requirement/build-scripts/typescript': fact({}, {
      for: DEVELOPMENT_INTENTS,
      value: ['esbuild'],
    }),
    '/file/vite-config/hoisted': file({ source: rdk.one('/source/directory') }, {
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
    '/command/typecheck/typescript': command({ requirement: rdk.one('/requirement/typescript') }, {
      for: ['typecheck'],
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    '/command/build/vite': command({ requirement: rdk.one('/requirement/typescript') }, {
      for: ['build'],
      run: () => ({ tool: 'vite build' }),
    }),
    '/target/ci/typecheck': sourceTarget(),
    '/target/ci/build': sourceTarget({ assets: true }),
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
    '/requirement/prettier': requirement({
      for: ['dev'],
      packages: ['prettier'],
    }),
    '/file/prettier-config/hoisted': file({}, {
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

export function biome({ formatter = true, linter = true } = {}) {
  return rdk.graph({
    '/file/biome-config/hoisted': file({}, {
      for: ['dev', 'lint'],
      render: () => writeJson('/repo/biome.json', {
        formatter: { enabled: formatter },
        linter: { enabled: linter },
      }),
    }),
    '/requirement/biome': requirement({
      for: ['dev', 'lint'],
      packages: ['@biomejs/biome'],
    }),
    ...(linter ? {
      '/command/lint/biome': command({ requirement: rdk.one('/requirement/biome') }, {
        for: ['lint'],
        run: () => ({ tool: 'biome check .' }),
      }),
      '/target/ci/lint': sourceTarget(),
    } : {}),
  })
}

export function vitest({ environment = 'node', globals = false, typecheck = false } = {}) {
  const configDeps = environment === 'jsdom'
    ? { viteConfig: rdk.one('/file/vite-config/hoisted') }
    : {}
  return rdk.graph({
    '/file/vitest-config/hoisted': file(configDeps, {
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
    '/requirement/vitest': requirement({
      for: ['dev', 'test', 'lint'],
      packages: ['vitest', ...(environment === 'jsdom' ? ['jsdom'] : [])],
      types: globals ? ['vitest/globals'] : [],
    }),
    '/requirement/build-scripts/vitest': fact({}, {
      for: ['dev', 'test', 'lint'],
      value: ['esbuild'],
    }),
    '/command/test/vitest': command({ requirement: rdk.one('/requirement/vitest') }, {
      for: ['test'],
      run: () => ({ tool: 'vitest run' }),
    }),
    '/target/ci/test': sourceTarget(),
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
    '/file/eslint-config/hoisted': file({ source: rdk.one('/source/directory') }, {
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
    '/requirement/eslint': requirement({ for: ['dev', 'lint'], packages }),
    '/command/lint/eslint': command({ requirement: rdk.one('/requirement/eslint') }, {
      for: ['lint'],
      run: () => ({ tool: 'eslint .' }),
    }),
    '/target/ci/lint': sourceTarget(),
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
    '/requirement/rollup': requirement({
      packages: ['@rollup/plugin-commonjs', '@rollup/plugin-node-resolve', 'rollup'],
    }),
    '/file/rollup-config': file({
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
    '/command/bundle/rollup': command({}, {
      for: ['bundle'],
      run: () => ({ tool: 'rollup --config rollup.config.js' }),
    }),
    '/target/ci/bundle': target({
      ignore: rdk.one('/source/ignore'),
      exec: rdk.one('/package-manager/exec'),
      bundleFile: rdk.one('/output/bundle-file'),
    }, {
      render: (context, { ignore, exec, bundleFile }) => ({
        deps: ['build'],
        run: ({ images }) => ({
          FROM: images.build,
          steps: [...context.files(), ...runSteps(context.invocations(), exec)],
          IGNORE: ignore,
          EXPORT: { [`/repo/${bundleFile}`]: bundleFile },
        }),
      }),
    }),
  })
}

export function typedoc({ title } = {}) {
  return rdk.graph({
    '/file/typedoc-config/hoisted': file({
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
    '/requirement/typedoc': requirement({
      for: ['dev', 'docs'],
      packages: ['typedoc'],
    }),
    '/command/docs/typedoc': command({ requirement: rdk.one('/requirement/typedoc') }, {
      for: ['docs'],
      run: () => ({ tool: 'typedoc' }),
    }),
    '/target/ci/docs': sourceTarget({ export: { '/repo/docs/': 'docs/' } }),
  })
}
