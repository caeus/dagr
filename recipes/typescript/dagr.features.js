import bundledVersions from '//dagr.versions.yaml'
import rdk from '//rdk//dagr.rdk.js'
import { COMMANDS, command, file, target } from '//dagr.contributions.js'
import { writeJson, writeText } from '//dagr.file-utils.js'
import { RECOMMENDED_IGNORE } from '//dagr.dockerignore.js'
import {
  DEVELOPMENT_INTENTS,
  DISTRIBUTION_INTENTS,
  REQUIREMENTS,
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

const nodeModulesExport = Object.freeze({ '/repo/node_modules': 'node_modules' })

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
  [
    'name', 'version', 'deps', 'metadata', 'scope', 'javascriptModuleFormat', 'productKind',
    'sourceDirectory', 'entryFile', 'outputLayout', 'importAlias', 'runtimePackages',
  ],
  (name, version, deps, metadata, scope, format, product, source, entry, output, alias, runtime) =>
    Object.freeze({
      name, version, deps, metadata, scope, format, product, source, entry, output, alias, runtime,
    }),
)

const packageJsonFile = file(
  [
    'packageFacts', { tag: REQUIREMENTS }, 'configuredVersions', 'installManifest', 'localPackages',
    'scripts',
  ],
  {
    for: [...DEVELOPMENT_INTENTS, ...DISTRIBUTION_INTENTS],
    render(context, facts, requirements, configuredVersions, installManifest, localPackages, scripts) {
      const tooling = requirementsOf(requirements, context, configuredVersions)
      const manifest = packageManifest(context, facts, tooling, configuredVersions, scripts)
      return writeJson(
        '/repo/package.json',
        context.install ? installManifest(manifest, localPackages, tooling, context) : manifest,
      )
    },
  },
)

const tsconfigFile = file(
  [
    'productKind', 'languageTarget', 'sourceMaps', 'emitDeclarations', 'sourceDirectory',
    'outputLayout', 'moduleKind', 'moduleResolutionKind', 'standardLibraries', 'importAlias',
    { tag: REQUIREMENTS }, 'configuredVersions',
  ],
  {
    for: DEVELOPMENT_INTENTS,
    render(
      context,
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
    ) {
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
export const sourceTarget = ({ name, facet = 'ci', intent = name, assets = false, export: exported } = {}) => target(
  ['base', 'ignore', 'sourceDirectory', 'localPackages', 'exec', 'install', ...(assets ? ['buildAssets'] : [])],
  {
    name,
    facet,
    intent,
    render(context, base, ignore, source, localPackages, exec, install, buildAssets = []) {
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
    base: rdk.value(base),
    ignore: rdk.value(ignore),
    scope: rdk.value(scope),
    configuredVersions: rdk.value(Object.freeze({ ...bundledVersions.deps, ...versions })),
    sourceDirectory: rdk.value(sourceDirectory),
    entryFile: rdk.value(entryFile),
    outputDirectory: rdk.value(outputDirectory),
    javascriptModuleFormat: rdk.value(javascriptModuleFormat),
    emitDeclarations: rdk.value(true),
    name: rdk.derive(['location', 'scope'], projectName),
    slug: rdk.derive(['name'], name => name.slice(name.indexOf('/') + 1)),
    sourceLayout: rdk.derive(['sourceDirectory', 'entryFile'], (directory, entry) => ({ directory, entry })),
    outputLayout: rdk.derive(['productKind', 'outputDirectory', 'entryFile'], (product, directory, entry) => {
      if (product === 'worker') return undefined
      if (product === 'web') return { directory }
      const stem = entry.replace(/\.[^.]+$/, '')
      return { directory, runtimeFile: `${directory}/${stem}.js`, declarationFile: `${directory}/${stem}.d.ts` }
    }),
    localPackages: rdk.derive(['deps', 'scope'], localPackagesOf),
    scripts: rdk.derive([{ tag: COMMANDS }, 'script'], scriptsFor),
    packageFacts,
    packageJsonFile,
    tsconfigFile,
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
    productKind: rdk.value('library'),
    runtimeKind: rdk.value(runtime),
    languageTarget: rdk.value(language),
    sourceMaps: rdk.value(sourceMaps),
    buildAssets: rdk.value(Object.freeze([...assets])),
    runtimePackages: rdk.value(Object.freeze([])),
    moduleKind: rdk.value(runtime === 'node' ? 'NodeNext' : 'ESNext'),
    moduleResolutionKind: rdk.value(runtime === 'node' ? 'NodeNext' : 'Bundler'),
    standardLibraries: rdk.value(Object.freeze([language])),
    importAlias: rdk.value(undefined),
    typescriptRequirements: requirement({
      packages,
      types,
    }),
    typecheckCommand: command(['typescriptRequirements'], {
      for: ['typecheck'],
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    buildCommand: command(['typescriptRequirements'], {
      for: ['build'],
      run: () => ({ tool: 'tsc' }),
    }),
    libraryTypecheckTarget: sourceTarget({ name: 'typecheck' }),
    libraryBuildTarget: sourceTarget({ name: 'build', assets: true }),
    libraryCiPackTarget: target(
      ['ignore', 'localPackages', 'exec'],
      {
        name: 'pack',
        facet: 'ci',
        render(context, ignore, localPackages, exec) {
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
    libraryPublishPackTarget: target(
      ['ignore', 'localPackages', 'exec'],
      {
        name: 'pack',
        facet: 'publish',
        intent: 'publish',
        render(context, ignore, localPackages, exec) {
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
    productKind: rdk.value('worker'),
    runtimeKind: rdk.value('cloudflare-worker'),
    languageTarget: rdk.value(language),
    sourceMaps: rdk.value(false),
    buildAssets: rdk.value(Object.freeze([])),
    runtimePackages: rdk.value(Object.freeze([])),
    moduleKind: rdk.value('NodeNext'),
    moduleResolutionKind: rdk.value('NodeNext'),
    standardLibraries: rdk.value(Object.freeze([language])),
    importAlias: rdk.derive(['sourceDirectory'], source => ({
      specifier: '#/*', sourcePath: `./${source}/*`, runtimePath: `./${source}/*`,
    })),
    typescriptRequirements: requirement({
      packages,
      types: ['@cloudflare/workers-types'],
      allowBuilds: ['sharp', 'workerd'],
    }),
    typecheckCommand: command(['typescriptRequirements'], {
      for: ['typecheck'],
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    workerTypecheckTarget: sourceTarget({ name: 'typecheck' }),
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
    productKind: rdk.value('web'),
    runtimeKind: rdk.value('browser'),
    languageTarget: rdk.value(language),
    sourceMaps: rdk.value(false),
    buildAssets: rdk.value(Object.freeze(['index.html', 'public'])),
    runtimePackages: rdk.value(viteRuntimePackages),
    moduleKind: rdk.value('ESNext'),
    moduleResolutionKind: rdk.value('Bundler'),
    standardLibraries: rdk.value(Object.freeze([language, 'DOM', 'DOM.Iterable'])),
    importAlias: rdk.derive(['sourceDirectory'], source => ({
      specifier: '#/*', sourcePath: `./${source}/*`, runtimePath: `./${source}/*`,
    })),
    vite: rdk.value(true),
    typescriptRequirements: requirement({
      packages,
      types: ['node'],
      allowBuilds: ['esbuild'],
    }),
    viteConfigFile: file(['sourceDirectory'], {
      for: ['dev', 'test', 'build'],
      render(_context, source) {
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
    typecheckCommand: command(['typescriptRequirements'], {
      for: ['typecheck'],
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    buildCommand: command(['typescriptRequirements'], {
      for: ['build'],
      run: () => ({ tool: 'vite build' }),
    }),
    viteTypecheckTarget: sourceTarget({ name: 'typecheck' }),
    viteBuildTarget: sourceTarget({ name: 'build', assets: true }),
    viteDevInstallTarget: target(
      ['base', 'ignore', 'localPackages', 'exec', 'install'],
      {
        name: 'install',
        facet: 'dev',
        intent: 'dev',
        render(context, base, ignore, localPackages, exec, install) {
          return {
            deps: [base, ...localPackages.map(pkg => pkg.target)],
            run: ({ images, host }) => ({
              FROM: images[base],
              steps: [
                ...copyLocalPackages(localPackages, images),
                { WORKDIR: '/repo' },
                ...context.files({ host, install: true }),
                { RUN: install(host) },
                ...runSteps(context.invocations({ host }), exec),
              ],
              IGNORE: ignore,
              EXPORT: nodeModulesExport,
            }),
          }
        },
      },
    ),
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
    prettierRequirements: requirement({
      for: ['dev'],
      packages: ['prettier'],
    }),
    prettierConfigFile: file([], {
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
    biomeConfigFile: file([], {
      for: ['dev', 'lint'],
      render: () => writeJson('/repo/biome.json', {
        formatter: { enabled: formatter },
        linter: { enabled: linter },
      }),
    }),
    biomeRequirements: requirement({
      for: ['dev', 'lint'],
      packages: ['@biomejs/biome'],
    }),
    ...(linter ? {
      biomeLintCommand: command(['biomeRequirements'], {
        for: ['lint'],
        run: () => ({ tool: 'biome check .' }),
      }),
      biomeLintTarget: sourceTarget({ name: 'lint' }),
    } : {}),
  })
}

export function vitest({ environment = 'node', globals = false, typecheck = false } = {}) {
  const configDeps = environment === 'jsdom' ? ['vite'] : []
  return rdk.graph({
    vitestConfigFile: file(configDeps, {
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
    vitestRequirements: requirement({
      for: ['dev', 'test', 'lint'],
      packages: ['vitest', ...(environment === 'jsdom' ? ['jsdom'] : [])],
      types: globals ? ['vitest/globals'] : [],
      allowBuilds: ['esbuild'],
    }),
    vitestTestCommand: command(['vitestRequirements'], {
      for: ['test'],
      run: () => ({ tool: 'vitest run' }),
    }),
    vitestTestTarget: sourceTarget({ name: 'test' }),
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
    eslintConfigFile: file(['sourceDirectory'], {
      for: ['dev', 'lint'],
      render(_context, source) {
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
    eslintRequirements: requirement({ for: ['dev', 'lint'], packages }),
    eslintLintCommand: command(['eslintRequirements'], {
      for: ['lint'],
      run: () => ({ tool: 'eslint .' }),
    }),
    eslintLintTarget: sourceTarget({ name: 'lint' }),
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
    bundleDirectory: rdk.value(bundleDirectory),
    bundleFile: rdk.derive(
      ['bundleDirectory', 'slug'],
      (directory, slug) => `${directory}/${slug}.js`,
    ),
    rollupRequirements: requirement({
      packages: ['@rollup/plugin-commonjs', '@rollup/plugin-node-resolve', 'rollup'],
    }),
    rollupConfigFile: file(['outputLayout', 'bundleFile'], {
      for: ['bundle'],
      render(_context, output, bundleFile) {
        if (output?.runtimeFile === undefined) {
          throw new Error('rollup() needs a product that emits JavaScript, such as library()')
        }
        return writeText('/repo/rollup.config.js', rollupConfig(output.runtimeFile, bundleFile, strict))
      },
    }),
    rollupBundleCommand: command([], {
      for: ['bundle'],
      run: () => ({ tool: 'rollup --config rollup.config.js' }),
    }),
    rollupBundleTarget: target(['ignore', 'exec', 'bundleFile'], {
      name: 'bundle',
      facet: 'ci',
      render: (context, ignore, exec, bundleFile) => ({
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
    typedocConfigFile: file(['sourceDirectory', 'entryFile', 'name', 'productKind'], {
      for: ['dev', 'docs'],
      render(context, source, entry, name, product) {
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
    typedocRequirements: requirement({
      for: ['dev', 'docs'],
      packages: ['typedoc'],
    }),
    typedocDocsCommand: command(['typedocRequirements'], {
      for: ['docs'],
      run: () => ({ tool: 'typedoc' }),
    }),
    typedocDocsTarget: sourceTarget({ name: 'docs', export: { '/repo/docs/': 'docs/' } }),
  })
}
