import bundledVersions from '//dagr.versions.yaml'
import rdk from '//rdk//dagr.rdk.js'
import { command, file, target } from '//dagr.contributions.js'
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
  [
    '/package/name', '/package/version', '/package/dependencies', '/package/metadata',
    '/package/scope', '/javascript/module-format', '/product/kind', '/source/directory',
    '/source/entry', '/output/layout', '/source/import-alias', '/package/runtime-dependencies',
  ],
  (name, version, deps, metadata, scope, format, product, source, entry, output, alias, runtime) =>
    Object.freeze({
      name, version, deps, metadata, scope, format, product, source, entry, output, alias, runtime,
    }),
)

const packageJson = file(
  [
    '/package/facts', '/requirement/**', '/version/catalog', '/package-manager/install-manifest',
    '/package/local-dependencies', '/package/scripts',
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

const tsconfig = file(
  [
    '/product/kind', '/typescript/language-target', '/output/source-maps',
    '/typescript/emit-declarations', '/source/directory', '/output/layout',
    '/typescript/module-kind', '/typescript/module-resolution', '/typescript/libraries',
    '/source/import-alias', '/requirement/**', '/version/catalog',
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
export const sourceTarget = ({ intent, assets = false, export: exported } = {}) => target(
  [
    '/image/base', '/source/ignore', '/source/directory', '/package/local-dependencies',
    '/package-manager/exec', '/package-manager/install', ...(assets ? ['/source/assets'] : []),
  ],
  {
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

/**
 * Renders the generated files onto the host, so an editor reads the same configuration a container
 * builds with. It copies no source, which is what makes the export precise: everything under /repo
 * is something the recipe produced, so exporting the whole directory cannot touch anything else.
 *
 * It deliberately does not install. Dependencies resolved inside a Linux image are the wrong ones for
 * a host, so `pnpm install` belongs to whoever owns the host, working from the manifest this writes.
 */
export function devSync() {
  return rdk.graph({
    '/target/dev/sync': target(
      ['/image/base', '/source/ignore', '/package/local-dependencies'],
      {
        intent: 'dev',
        render(context, base, ignore, localPackages) {
          return {
            deps: [base, ...localPackages.map(pkg => pkg.target)],
            run: ({ images, host }) => ({
              FROM: images[base],
              steps: [
                ...copyLocalPackages(localPackages, images),
                { WORKDIR: '/repo' },
                ...context.files({ host, install: true }),
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
    '/package/name': rdk.derive(['/package/location', '/package/scope'], projectName),
    '/package/slug': rdk.derive(['/package/name'], name => name.slice(name.indexOf('/') + 1)),
    '/source/layout': rdk.derive(['/source/directory', '/source/entry'], (directory, entry) => ({ directory, entry })),
    '/output/layout': rdk.derive(['/product/kind', '/output/directory', '/source/entry'], (product, directory, entry) => {
      if (product === 'worker') return undefined
      if (product === 'web') return { directory }
      const stem = entry.replace(/\.[^.]+$/, '')
      return { directory, runtimeFile: `${directory}/${stem}.js`, declarationFile: `${directory}/${stem}.d.ts` }
    }),
    '/package/local-dependencies': rdk.derive(['/package/dependencies', '/package/scope'], localPackagesOf),
    '/package/scripts': rdk.derive(['/command/**', '/package-manager/script'], scriptsFor),
    '/package/facts': packageFacts,
    '/file/package-json': packageJson,
    '/file/tsconfig': tsconfig,
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
    '/command/typecheck/typescript': command(['/requirement/typescript'], {
      for: ['typecheck'],
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    '/command/build/typescript': command(['/requirement/typescript'], {
      for: ['build'],
      run: () => ({ tool: 'tsc' }),
    }),
    '/target/ci/typecheck': sourceTarget(),
    '/target/ci/build': sourceTarget({ assets: true }),
    '/target/ci/pack': target(
      ['/source/ignore', '/package/local-dependencies', '/package-manager/exec'],
      {
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
    '/target/publish/pack': target(
      ['/source/ignore', '/package/local-dependencies', '/package-manager/exec'],
      {
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
    '/product/kind': rdk.value('worker'),
    '/runtime/kind': rdk.value('cloudflare-worker'),
    '/typescript/language-target': rdk.value(language),
    '/output/source-maps': rdk.value(false),
    '/source/assets': rdk.value(Object.freeze([])),
    '/package/runtime-dependencies': rdk.value(Object.freeze([])),
    '/typescript/module-kind': rdk.value('NodeNext'),
    '/typescript/module-resolution': rdk.value('NodeNext'),
    '/typescript/libraries': rdk.value(Object.freeze([language])),
    '/source/import-alias': rdk.derive(['/source/directory'], source => ({
      specifier: '#/*', sourcePath: `./${source}/*`, runtimePath: `./${source}/*`,
    })),
    '/requirement/typescript': requirement({
      packages,
      types: ['@cloudflare/workers-types'],
      allowBuilds: ['sharp', 'workerd'],
    }),
    '/command/typecheck/typescript': command(['/requirement/typescript'], {
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
    '/source/import-alias': rdk.derive(['/source/directory'], source => ({
      specifier: '#/*', sourcePath: `./${source}/*`, runtimePath: `./${source}/*`,
    })),
    '/requirement/typescript': requirement({
      packages,
      types: ['node'],
      allowBuilds: ['esbuild'],
    }),
    '/file/vite-config': file(['/source/directory'], {
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
    '/command/typecheck/typescript': command(['/requirement/typescript'], {
      for: ['typecheck'],
      run: () => ({ tool: 'tsc --noEmit' }),
    }),
    '/command/build/vite': command(['/requirement/typescript'], {
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
    '/file/prettier-config': file([], {
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
    '/file/biome-config': file([], {
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
      '/command/lint/biome': command(['/requirement/biome'], {
        for: ['lint'],
        run: () => ({ tool: 'biome check .' }),
      }),
      '/target/ci/lint': sourceTarget(),
    } : {}),
  })
}

export function vitest({ environment = 'node', globals = false, typecheck = false } = {}) {
  const configDeps = environment === 'jsdom' ? ['/file/vite-config'] : []
  return rdk.graph({
    '/file/vitest-config': file(configDeps, {
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
      allowBuilds: ['esbuild'],
    }),
    '/command/test/vitest': command(['/requirement/vitest'], {
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
    '/file/eslint-config': file(['/source/directory'], {
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
    '/requirement/eslint': requirement({ for: ['dev', 'lint'], packages }),
    '/command/lint/eslint': command(['/requirement/eslint'], {
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
      ['/output/bundle-directory', '/package/slug'],
      (directory, slug) => `${directory}/${slug}.js`,
    ),
    '/requirement/rollup': requirement({
      packages: ['@rollup/plugin-commonjs', '@rollup/plugin-node-resolve', 'rollup'],
    }),
    '/file/rollup-config': file(['/output/layout', '/output/bundle-file'], {
      for: ['bundle'],
      render(_context, output, bundleFile) {
        if (output?.runtimeFile === undefined) {
          throw new Error('rollup() needs a product that emits JavaScript, such as library()')
        }
        return writeText('/repo/rollup.config.js', rollupConfig(output.runtimeFile, bundleFile, strict))
      },
    }),
    '/command/bundle/rollup': command([], {
      for: ['bundle'],
      run: () => ({ tool: 'rollup --config rollup.config.js' }),
    }),
    '/target/ci/bundle': target(['/source/ignore', '/package-manager/exec', '/output/bundle-file'], {
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
    '/file/typedoc-config': file(['/source/directory', '/source/entry', '/package/name', '/product/kind'], {
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
    '/requirement/typedoc': requirement({
      for: ['dev', 'docs'],
      packages: ['typedoc'],
    }),
    '/command/docs/typedoc': command(['/requirement/typedoc'], {
      for: ['docs'],
      run: () => ({ tool: 'typedoc' }),
    }),
    '/target/ci/docs': sourceTarget({ export: { '/repo/docs/': 'docs/' } }),
  })
}
