import rdk from '//rdk//dagr.rdk.js'

const facetsByName = new Map()
const facetsByTargetTag = new Map()

export function facet(name) {
  if (!name) throw new Error('TypeScript facet needs a name')
  if (facetsByName.has(name)) return facetsByName.get(name)
  const value = Object.freeze({ name, targets: Symbol(`${name} targets`) })
  facetsByName.set(name, value)
  facetsByTargetTag.set(value.targets, value)
  return value
}

export const configFacet = facet('config')
export const devFacet = facet('dev')
export const ciFacet = facet('ci')
export const publishFacet = facet('publish')

export function facetOf(definition) {
  const facets = definition.tags.map(tag => facetsByTargetTag.get(tag)).filter(Boolean)
  if (facets.length > 1) throw new Error('A target setting cannot belong to multiple facets')
  return facets[0]
}

const versionDefaults = entries => rdk.value(
  Object.freeze({ ...entries }),
  ['versionDefaults'],
)

export const requires = (...dependencies) => rdk.derive(
  dependencies,
  () => true,
  ['validations'],
)

export function target(name, { deps = [], run } = {}) {
  if (!name) throw new Error('TypeScript target needs a name')
  if (typeof run !== 'function') throw new Error(`TypeScript target ${JSON.stringify(name)} needs run`)
  return Object.freeze({
    name,
    deps: Object.freeze([...deps]),
    run,
  })
}

const hasIntent = (intents, intent) => intents.includes(intent)

const contributedTargetNames = contributions => Reflect.ownKeys(contributions)
  .map(name => contributions[name])
  .filter(target => target !== undefined)
  .map(target => target.name)

const mergeRecords = (label, records) => {
  const result = {}
  for (const record of records) {
    for (const [key, entry] of Object.entries(record)) {
      if (Object.hasOwn(result, key)) {
        throw new Error(`${label} ${JSON.stringify(key)} has more than one owner`)
      }
      result[key] = entry
    }
  }
  return result
}

const copySource = directory => ({ COPY: { src: directory, dest: `/repo/${directory}` } })
const copyAssets = assets => assets.map(path => ({ COPY: { src: path, dest: `/repo/${path}` } }))

const packageManagerConfigSteps = (workspace, runtime) => runtime.packageManager
  .configFiles(workspace)
  .map(({ path, format, value }) => {
    if (format === 'yaml') return runtime.writeYaml(`/repo/${path}`, value)
    if (format === 'text') return runtime.writeText(`/repo/${path}`, value)
    if (format === 'json') return runtime.writeJson(`/repo/${path}`, value)
    throw new Error(`Unknown package-manager config format ${JSON.stringify(format)}`)
  })

const configurationTarget = (name, workspace, runtime) => target(name, {
  deps: [runtime.base],
  run: ({ images }) => ({
    FROM: images[runtime.base],
    steps: [
      { WORKDIR: '/repo' },
      ...Object.entries(workspace.files).map(([path, value]) => runtime.writeProjectedFile(path, value)),
    ],
    IGNORE: runtime.ignore,
  }),
})

const installTarget = (name, workspace, runtime) => target(`install-${name}`, {
  deps: [`config:${name}`, ...runtime.packTargets],
  run: ({ images }) => ({
    FROM: images[`config:${name}`],
    steps: [
      ...runtime.localDeps.map(dependency => ({
        COPY: { from: images[runtime.packTarget(dependency)], src: '/out', dest: '/repo' },
      })),
      { WORKDIR: '/repo' },
      runtime.writeJson('/repo/package.json', runtime.installPackageJson(workspace.packageJson)),
      ...packageManagerConfigSteps(workspace, runtime),
      { RUN: runtime.packageManager.install() },
    ],
    IGNORE: runtime.ignore,
  }),
})

const commandTarget = (name, command, workspace, runtime, dependencies, { assets = false, export: output } = {}) =>
  target(name, {
    deps: [`install-${name}`, ...contributedTargetNames(dependencies)],
    run: ({ images }) => ({
      FROM: images[`install-${name}`],
      steps: [
        copySource(workspace.semantics.sourceLayout.directory),
        ...(assets ? copyAssets(workspace.buildAssets) : []),
        { WORKDIR: '/repo' },
        { RUN: runtime.packageManager.exec(command) },
      ],
      IGNORE: runtime.ignore,
      ...(output ? { EXPORT: output } : {}),
    }),
  })

const commandTargets = (prefix, name, command, {
  assets = false,
  buildDependency = false,
  dependencies = false,
  enabled,
  export: output,
} = {}) => {
  const enabledDeps = enabled ? [enabled] : []
  const enabledFactory = factory => (...values) => {
    const isEnabled = enabled ? values.shift() : true
    return isEnabled ? factory(...values) : undefined
  }
  return {
    [`${prefix}ConfigTarget`]: rdk.derive(
      [...enabledDeps, `config:${name}/workspace`, '#dagrRuntime'],
      enabledFactory((workspace, runtime) => configurationTarget(name, workspace, runtime)),
      [configFacet.targets],
    ),
    [`${prefix}InstallTarget`]: rdk.derive(
      [...enabledDeps, `config:${name}/workspace`, '#dagrRuntime'],
      enabledFactory((workspace, runtime) => installTarget(name, workspace, runtime)),
      [ciFacet.targets],
    ),
    [`${prefix}Target`]: rdk.derive(
      [
        ...enabledDeps,
        ...(dependencies ? [{ tag: 'buildDependencies' }] : []),
        `ci:${name}/workspace`,
        '#dagrRuntime',
      ],
      enabledFactory((...values) => {
        const runtime = values.pop()
        const workspace = values.pop()
        const runtimeDependencies = dependencies ? values.pop() : {}
        return commandTarget(name, command, workspace, runtime, runtimeDependencies, { assets, export: output })
      }),
      [ciFacet.targets, ...(buildDependency ? ['buildDependencies'] : [])],
    ),
  }
}

const packTarget = (name, workspace, runtime, dependencies, { dependencyFacet } = {}) => {
  const dependencyNames = contributedTargetNames(dependencies)
    .map(dependency => dependencyFacet ? `${dependencyFacet}:${dependency}` : dependency)
  return target(name, {
    deps: [...dependencyNames, ...runtime.packTargets],
    run: ({ images }) => ({
      FROM: images[dependencyNames[0]],
      steps: [
        ...runtime.localDeps.map(dependency => ({
          COPY: { from: images[runtime.packTarget(dependency)], src: '/out', dest: '/out' },
        })),
        { WORKDIR: '/repo' },
        runtime.writeJson('/repo/package.json', workspace.packageJson),
        { RUN: runtime.packageManager.pack(workspace.slug) },
      ],
      IGNORE: runtime.ignore,
    }),
  })
}

const hostInstallTarget = (name, workspace, runtime) => target(name, {
  deps: ['config:dev', ...runtime.packTargets],
  run: ({ images, host }) => ({
    FROM: images['config:dev'],
    steps: [
      ...runtime.localDeps.map(dependency => ({
        COPY: { from: images[runtime.packTarget(dependency)], src: '/out', dest: '/repo' },
      })),
      { WORKDIR: '/repo' },
      runtime.writeJson('/repo/package.json', runtime.installPackageJson(workspace.packageJson)),
      ...packageManagerConfigSteps(workspace, runtime),
      { RUN: runtime.packageManager.install({ host }) },
    ],
    IGNORE: runtime.ignore,
    EXPORT: { '/repo/node_modules': 'node_modules' },
  }),
})

export function library({
  runtime = 'portable',
  language = runtime === 'node' ? 'ES2023' : 'ES2022',
  sourceMaps = false,
  assets = [],
} = {}) {
  if (!['portable', 'node'].includes(runtime)) {
    throw new Error(`library runtime must be portable or node, got ${JSON.stringify(runtime)}`)
  }
  const inputs = {
    productKind: 'library',
    runtimeKind: runtime,
    languageTarget: language,
    sourceMapIntent: sourceMaps,
    buildAssetInputs: Object.freeze([...assets]),
  }
  const settings = {
    moduleKind: rdk.derive(['runtimeKind'], runtime => runtime === 'node' ? 'NodeNext' : 'ESNext'),
    moduleResolutionKind: rdk.derive(
      ['runtimeKind'],
      runtime => runtime === 'node' ? 'NodeNext' : 'Bundler',
    ),
    standardLibraries: rdk.derive(['languageTarget'], target => [target]),
    baseAmbientTypes: rdk.derive(
      ['runtimeKind'],
      runtime => runtime === 'node' ? ['node'] : [],
      ['ambientTypes'],
    ),
    importAlias: rdk.derive([], () => undefined),
    productToolPackages: rdk.derive(
      ['intent', 'developmentIntents', 'runtimeKind'],
      (intent, intents, runtime) => hasIntent(intents, intent)
        ? ['@tsconfig/strictest', ...(runtime === 'node' ? ['@types/node'] : []), 'typescript']
        : [],
      ['toolPackages'],
    ),
    productRuntimePackages: rdk.derive([], () => [], ['runtimePackages']),
    productAllowBuilds: rdk.derive([], () => [], ['allowBuilds']),
    libraryVersionDefaults: versionDefaults({ '@types/node': '26.2.0' }),
    buildAssets: rdk.derive(['buildAssetInputs'], assets => assets),
    ...commandTargets('libraryTypecheck', 'typecheck', 'tsc --noEmit'),
    ...commandTargets('libraryBuild', 'build', 'tsc', {
      assets: true,
      dependencies: true,
    }),
    libraryCiPackTarget: rdk.derive(
      ['libraryBuildTarget', 'ci:pack/workspace', '#dagrRuntime'],
      (build, workspace, runtime) => packTarget('pack', workspace, runtime, { build }),
      [ciFacet.targets],
    ),
    libraryPublishPackTarget: rdk.derive(
      ['libraryBuildTarget', 'publish:pack/workspace', '#dagrRuntime'],
      (build, workspace, runtime) => packTarget('pack', workspace, runtime, { build }, {
        dependencyFacet: ciFacet.name,
      }),
      [publishFacet.targets],
    ),
  }
  return rdk.graph({
    ...Object.fromEntries(Reflect.ownKeys(inputs).map(key => [key, rdk.value(inputs[key])])),
    ...settings,
  })
}

export function cloudflareWorker({ language = 'ES2022' } = {}) {
  const inputs = {
    productKind: 'worker',
    runtimeKind: 'cloudflare-worker',
    languageTarget: language,
    sourceMapIntent: false,
    buildAssetInputs: Object.freeze([]),
  }
  const settings = {
    moduleKind: rdk.derive([], () => 'NodeNext'),
    moduleResolutionKind: rdk.derive([], () => 'NodeNext'),
    standardLibraries: rdk.derive(['languageTarget'], target => [target]),
    baseAmbientTypes: rdk.derive([], () => ['@cloudflare/workers-types'], ['ambientTypes']),
    importAlias: rdk.derive(
      ['sourceDirectory'],
      directory => ({
        specifier: '#/*',
        sourcePath: `./${directory}/*`,
        runtimePath: `./${directory}/*`,
      }),
    ),
    productToolPackages: rdk.derive(['intent', 'developmentIntents'], (intent, intents) =>
      hasIntent(intents, intent)
        ? ['@tsconfig/strictest', '@cloudflare/workers-types', 'typescript', 'wrangler']
        : [], ['toolPackages']),
    productRuntimePackages: rdk.derive([], () => [], ['runtimePackages']),
    productAllowBuilds: rdk.derive([], () => ['sharp', 'workerd'], ['allowBuilds']),
    cloudflareVersionDefaults: versionDefaults({
      '@cloudflare/workers-types': '4.20250620.0',
      wrangler: '4.0.0',
    }),
    buildAssets: rdk.derive(['buildAssetInputs'], assets => assets),
    ...commandTargets('cloudflareTypecheck', 'typecheck', 'tsc --noEmit'),
  }
  return rdk.graph({
    ...Object.fromEntries(Reflect.ownKeys(inputs).map(key => [key, rdk.value(inputs[key])])),
    ...settings,
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
  const inputs = {
    productKind: 'web',
    runtimeKind: 'browser',
    languageTarget: language,
    sourceMapIntent: false,
    buildAssetInputs: Object.freeze(['index.html', 'public']),
  }
  const settings = {
    moduleKind: rdk.derive([], () => 'ESNext'),
    moduleResolutionKind: rdk.derive([], () => 'Bundler'),
    standardLibraries: rdk.derive(['languageTarget'], target => [target, 'DOM', 'DOM.Iterable']),
    baseAmbientTypes: rdk.derive([], () => [], ['ambientTypes']),
    importAlias: rdk.derive(
      ['sourceDirectory'],
      directory => ({
        specifier: '#/*',
        sourcePath: `./${directory}/*`,
        runtimePath: `./${directory}/*`,
      }),
    ),
    productToolPackages: rdk.derive(['intent', 'developmentIntents'], (intent, intents) =>
      hasIntent(intents, intent)
        ? ['@tsconfig/strictest', '@types/node', '@types/react', '@types/react-dom', 'typescript', 'vite']
        : [], ['toolPackages']),
    productRuntimePackages: rdk.derive([], () => viteRuntimePackages, ['runtimePackages']),
    productAllowBuilds: rdk.derive([], () => ['esbuild'], ['allowBuilds']),
    viteVersionDefaults: versionDefaults({
      '@tailwindcss/vite': '4.3.3',
      '@types/node': '26.2.0',
      '@types/react': '19.2.18',
      '@types/react-dom': '19.2.4',
      '@vitejs/plugin-react': '4.7.0',
      'class-variance-authority': '0.7.1',
      clsx: '2.1.1',
      react: '19.2.8',
      'react-dom': '19.2.8',
      'react-router-dom': '7.18.2',
      'tailwind-merge': '3.6.0',
      tailwindcss: '4.3.3',
      vite: '5.3.1',
    }),
    buildAssets: rdk.derive(['buildAssetInputs'], assets => assets),
    viteIntents: rdk.derive([], () => Object.freeze(['dev', 'test', 'build'])),
    'vite.plugins': rdk.derive([], () => ['react', 'tailwindcss']),
    'vite.resolve.alias': rdk.derive(
      ['importAlias'],
      alias => ({
        [alias.specifier.replace(/\*$/, '')]: alias.sourcePath.replace(/\*$/, ''),
      }),
    ),
    viteConfig: rdk.derive(
      ['intent', 'viteIntents', 'vite.plugins', 'vite.resolve.alias'],
      (intent, intents, plugins, aliases) => {
        if (!hasIntent(intents, intent)) return undefined
        const renderedAliases = Object.entries(aliases)
          .map(([specifier, path]) =>
            `${JSON.stringify(specifier)}: fileURLToPath(new URL(${JSON.stringify(path)}, import.meta.url))`)
          .join(', ')
        return `import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [${plugins.map(plugin => `${plugin}()`).join(', ')}],
  resolve: { alias: { ${renderedAliases} } },
})
`
      },
    ),
    viteGeneratedFiles: rdk.derive(
      ['viteConfig'],
      config => config === undefined ? {} : { 'vite.config.ts': config },
      ['generatedFiles'],
    ),
    ...commandTargets('viteTypecheck', 'typecheck', 'tsc --noEmit'),
    ...commandTargets('viteBuild', 'build', 'vite build', {
      assets: true,
      dependencies: true,
    }),
    viteDevInstallTarget: rdk.derive(
      ['config:dev/workspace', '#dagrRuntime'],
      (workspace, runtime) => hostInstallTarget('install', workspace, runtime),
      [devFacet.targets],
    ),
  }
  return rdk.graph({
    ...Object.fromEntries(Reflect.ownKeys(inputs).map(key => [key, rdk.value(inputs[key])])),
    ...settings,
  })
}

export function prettier({
  semi = false,
  tabWidth = 2,
  singleQuote = true,
  printWidth = 100,
  trailingComma = 'none',
} = {}) {
  const inputs = {
    formatSemicolons: semi,
    formatTabWidth: tabWidth,
    formatSingleQuotes: singleQuote,
    formatPrintWidth: printWidth,
    formatTrailingCommas: trailingComma,
  }
  const settings = {
    prettierIntents: rdk.derive([], () => Object.freeze(['dev', 'lint'])),
    prettierVersionDefaults: versionDefaults({ prettier: '3.3.3' }),
    prettierToolPackages: rdk.derive(['intent', 'prettierIntents'], (intent, intents) =>
      hasIntent(intents, intent) ? ['prettier'] : [], ['toolPackages']),
    'prettier.$schema': rdk.derive([], () => 'https://json.schemastore.org/prettierrc'),
    'prettier.semi': rdk.derive(['formatSemicolons'], value => value),
    'prettier.tabWidth': rdk.derive(['formatTabWidth'], value => value),
    'prettier.singleQuote': rdk.derive(['formatSingleQuotes'], value => value),
    'prettier.printWidth': rdk.derive(['formatPrintWidth'], value => value),
    'prettier.trailingComma': rdk.derive(['formatTrailingCommas'], value => value),
    prettierConfig: rdk.derive(
      [
        'intent',
        'prettierIntents',
        'prettier.$schema',
        'prettier.semi',
        'prettier.tabWidth',
        'prettier.singleQuote',
        'prettier.printWidth',
        'prettier.trailingComma',
      ],
      (intent, intents, schema, semicolons, width, quotes, printWidth, commas) =>
        hasIntent(intents, intent)
          ? { $schema: schema, semi: semicolons, tabWidth: width, singleQuote: quotes, printWidth, trailingComma: commas }
          : undefined,
    ),
    prettierGeneratedFiles: rdk.derive(
      ['prettierConfig'],
      config => config === undefined ? {} : { '.prettierrc.json': config },
      ['generatedFiles'],
    ),
  }
  return rdk.graph({
    ...Object.fromEntries(Reflect.ownKeys(inputs).map(key => [key, rdk.value(inputs[key])])),
    ...settings,
  })
}

export function biome({ formatter = true, linter = true } = {}) {
  return rdk.graph({
    biomeFormatterIntent: rdk.value(formatter),
    biomeLinterIntent: rdk.value(linter),
    biomeIntents: rdk.value(Object.freeze(['dev', 'lint'])),
    biomeVersionDefaults: versionDefaults({ '@biomejs/biome': '2.5.10' }),
    biomeToolPackages: rdk.derive(
      ['intent', 'biomeIntents'],
      (intent, intents) => hasIntent(intents, intent) ? ['@biomejs/biome'] : [],
      ['toolPackages'],
    ),
    'biome.formatter.enabled': rdk.derive(['biomeFormatterIntent'], enabled => enabled),
    'biome.linter.enabled': rdk.derive(['biomeLinterIntent'], enabled => enabled),
    biomeConfig: rdk.derive(
      ['intent', 'biomeIntents', 'biome.formatter.enabled', 'biome.linter.enabled'],
      (intent, intents, formatterEnabled, linterEnabled) => hasIntent(intents, intent)
        ? { formatter: { enabled: formatterEnabled }, linter: { enabled: linterEnabled } }
        : undefined,
    ),
    biomeGeneratedFiles: rdk.derive(
      ['biomeConfig'],
      config => config === undefined ? {} : { 'biome.json': config },
      ['generatedFiles'],
    ),
    ...commandTargets('biomeLint', 'lint', 'biome check .', {
      buildDependency: true,
      enabled: 'ci:lint/biomeLinterIntent',
    }),
  })
}

export function vitest({ environment = 'node', globals = false, typecheck = false } = {}) {
  const inputs = {
    testEnvironment: environment,
    testGlobalsIntent: globals,
    testTypecheckIntent: typecheck,
  }
  const settings = {
    vitestIntents: rdk.derive([], () => Object.freeze(['dev', 'test'])),
    vitestDependencyIntents: rdk.derive([], () => Object.freeze(['dev', 'test', 'lint'])),
    vitestTypeIntents: rdk.derive([], () => Object.freeze(['dev', 'test', 'lint'])),
    vitestVersionDefaults: versionDefaults({
      jsdom: '30.0.1',
      vitest: '3.2.7',
    }),
    ...(environment === 'jsdom' ? { vitestViteRequirement: requires('viteConfig') } : {}),
    vitestToolPackages: rdk.derive(['intent', 'vitestDependencyIntents', 'testEnvironment'], (intent, intents, env) =>
      hasIntent(intents, intent) ? ['vitest', ...(env === 'jsdom' ? ['jsdom'] : [])] : [], ['toolPackages']),
    vitestAmbientTypes: rdk.derive(
      ['intent', 'vitestTypeIntents', 'testGlobalsIntent'],
      (intent, intents, globals) => globals && hasIntent(intents, intent) ? ['vitest/globals'] : [],
      ['ambientTypes'],
    ),
    'vitest.test.environment': rdk.derive(['testEnvironment'], value => value),
    'vitest.test.globals': rdk.derive(['testGlobalsIntent'], value => value),
    'vitest.test.typecheck.enabled': rdk.derive(['testTypecheckIntent'], value => value),
    'vitest.test.exclude': rdk.derive(
      ['testEnvironment'],
      env => env === 'jsdom' ? ['...configDefaults.exclude', 'e2e/**'] : undefined,
    ),
    'vitest.test.root': rdk.derive(
      ['testEnvironment'],
      env => env === 'jsdom' ? './' : undefined,
    ),
    vitestConfig: rdk.derive(
      [
        'intent',
        'vitestIntents',
        'vitest.test.environment',
        'vitest.test.globals',
        'vitest.test.typecheck.enabled',
        'vitest.test.exclude',
        'vitest.test.root',
      ],
      (intent, intents, env, globals, typecheckEnabled, exclude, root) => {
        if (!hasIntent(intents, intent)) return undefined
        if (env === 'jsdom') return `import { fileURLToPath } from 'node:url'
import { defineConfig, configDefaults, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(viteConfig, defineConfig({ test: {
  environment: ${JSON.stringify(env)},
  exclude: [...configDefaults.exclude, ${JSON.stringify(exclude[1])}],
  root: fileURLToPath(new URL(${JSON.stringify(root)}, import.meta.url)),
  globals: ${globals},
  typecheck: { enabled: ${typecheckEnabled} },
} }))
`
        return `import { defineConfig } from 'vitest/config'

export default defineConfig({ test: {
  environment: ${JSON.stringify(env)},
  globals: ${globals},
  typecheck: { enabled: ${typecheckEnabled} },
} })
`
      },
    ),
    vitestGeneratedFiles: rdk.derive(
      ['vitestConfig'],
      config => config === undefined ? {} : { 'vitest.config.ts': config },
      ['generatedFiles'],
    ),
    vitestAllowBuilds: rdk.derive([], () => ['esbuild'], ['allowBuilds']),
    ...commandTargets('vitestTest', 'test', 'vitest run', {
      buildDependency: true,
    }),
  }
  return rdk.graph({
    ...Object.fromEntries(Reflect.ownKeys(inputs).map(key => [key, rdk.value(inputs[key])])),
    ...settings,
  })
}

export function eslint({ prettier: enforceFormatting = false, explicitReturnTypes = false } = {}) {
  const inputs = {
    lintFormattingIntent: enforceFormatting,
    lintExplicitReturnTypesIntent: explicitReturnTypes,
  }
  const settings = {
    eslintIntents: rdk.derive([], () => Object.freeze(['dev', 'lint'])),
    eslintVersionDefaults: versionDefaults({
      '@eslint/js': '9.12.0',
      '@typescript-eslint/eslint-plugin': '8.66.0',
      '@typescript-eslint/parser': '8.66.0',
      eslint: '9.12.0',
      'eslint-plugin-prettier': '5.2.1',
      prettier: '3.3.3',
    }),
    'eslint.enabled': rdk.derive([], () => true),
    eslintToolPackages: rdk.derive(
      ['intent', 'eslintIntents', 'lintFormattingIntent'],
      (intent, intents, formatting) => hasIntent(intents, intent)
        ? [
            '@eslint/js',
            '@typescript-eslint/eslint-plugin',
            '@typescript-eslint/parser',
            'eslint',
            ...(formatting ? ['eslint-plugin-prettier', 'prettier'] : []),
          ]
        : [],
      ['toolPackages'],
    ),
    'eslint.languageOptions.parser': rdk.derive([], () => '@typescript-eslint/parser'),
    'eslint.languageOptions.parserOptions.project': rdk.derive([], () => './tsconfig.json'),
    'eslint.files': rdk.derive(
      ['sourceLayout'],
      layout => [`${layout.directory}/**/*.ts`, `${layout.directory}/**/*.tsx`],
    ),
    'eslint.testFiles': rdk.derive(
      ['sourceLayout'],
      layout => [
        `${layout.directory}/**/*.test.ts`,
        `${layout.directory}/**/*.spec.ts`,
        `${layout.directory}/**/*.test.tsx`,
        `${layout.directory}/**/*.spec.tsx`,
      ],
    ),
    'eslint.rules.no-undef': rdk.derive([], () => 'off'),
    'eslint.rules.no-redeclare': rdk.derive([], () => 'off'),
    'eslint.rules.no-dupe-class-members': rdk.derive([], () => 'off'),
    'eslint.rules.@typescript-eslint/no-empty-object-type': rdk.derive([], () => 'off'),
    'eslint.rules.@typescript-eslint/no-unused-vars': rdk.derive([], () => 'error'),
    'eslint.rules.@typescript-eslint/explicit-function-return-type': rdk.derive(
      ['lintExplicitReturnTypesIntent'],
      enabled => enabled ? 'error' : undefined,
    ),
    'eslint.rules.prettier/prettier': rdk.derive(
      ['lintFormattingIntent'],
      enabled => enabled ? 'error' : undefined,
    ),
    eslintRules: rdk.derive(
      [
        'eslint.rules.no-undef',
        'eslint.rules.no-redeclare',
        'eslint.rules.no-dupe-class-members',
        'eslint.rules.@typescript-eslint/no-empty-object-type',
        'eslint.rules.@typescript-eslint/no-unused-vars',
        'eslint.rules.@typescript-eslint/explicit-function-return-type',
        'eslint.rules.prettier/prettier',
        { tag: 'eslint.ruleSets' },
      ],
      (noUndef, noRedeclare, noDupeClassMembers, emptyObject, unused, returns, formatting, extensions) =>
        mergeRecords('ESLint rule', [
          {
            'no-undef': noUndef,
            'no-redeclare': noRedeclare,
            'no-dupe-class-members': noDupeClassMembers,
            '@typescript-eslint/no-empty-object-type': emptyObject,
            '@typescript-eslint/no-unused-vars': unused,
            ...(returns === undefined ? {} : { '@typescript-eslint/explicit-function-return-type': returns }),
            ...(formatting === undefined ? {} : { 'prettier/prettier': formatting }),
          },
          ...Reflect.ownKeys(extensions).map(name => extensions[name]),
        ]),
    ),
    eslintConfig: rdk.derive(
      [
        'intent',
        'eslintIntents',
        'lintFormattingIntent',
        'eslint.files',
        'eslint.testFiles',
        'eslint.languageOptions.parserOptions.project',
        'eslintRules',
      ],
      (intent, intents, formatting, files, testFiles, project, rules) => hasIntent(intents, intent)
        ? `import js from '@eslint/js'
import parser from '@typescript-eslint/parser'
import plugin from '@typescript-eslint/eslint-plugin'
${formatting ? "import prettier from 'eslint-plugin-prettier'\n" : ''}export default [
  js.configs.recommended,
  {
    files: ${JSON.stringify(files)},
    languageOptions: { parser, parserOptions: { project: ${JSON.stringify(project)} } },
    plugins: { '@typescript-eslint': plugin${formatting ? ', prettier' : ''} },
    rules: { ...plugin.configs.recommended.rules, ...${JSON.stringify(rules)} },
  },
  {
    files: ${JSON.stringify(testFiles)},
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
]
`
        : undefined,
    ),
    eslintGeneratedFiles: rdk.derive(
      ['eslintConfig'],
      config => config === undefined ? {} : { 'eslint.config.mjs': config },
      ['generatedFiles'],
    ),
    ...commandTargets('eslintLint', 'lint', 'eslint .', {
      buildDependency: true,
    }),
  }
  return rdk.graph({
    ...Object.fromEntries(Reflect.ownKeys(inputs).map(key => [key, rdk.value(inputs[key])])),
    ...settings,
  })
}

export function typedoc({ title } = {}) {
  const inputs = { documentationTitle: title }
  const settings = {
    typedocIntents: rdk.derive([], () => Object.freeze(['dev', 'docs'])),
    typedocVersionDefaults: versionDefaults({ typedoc: '0.28.13' }),
    typedocToolPackages: rdk.derive(['intent', 'typedocIntents'], (intent, intents) =>
      hasIntent(intents, intent) ? ['typedoc'] : [], ['toolPackages']),
    'typedoc.entryPoints': rdk.derive(['sourceEntry'], entry => [entry]),
    'typedoc.name': rdk.derive(
      ['documentationTitle', 'name'],
      (title, name) => title ?? name,
    ),
    'typedoc.includeVersion': rdk.derive([], () => true),
    'typedoc.excludeExternals': rdk.derive([], () => true),
    'typedoc.excludePrivate': rdk.derive([], () => true),
    'typedoc.excludeProtected': rdk.derive([], () => true),
    'typedoc.exclude': rdk.derive(
      ['sourceSet'],
      sources => sources.exclude ?? [],
    ),
    typedocConfig: rdk.derive(
      [
        'intent',
        'typedocIntents',
        'typedoc.entryPoints',
        'typedoc.name',
        'typedoc.includeVersion',
        'typedoc.excludeExternals',
        'typedoc.excludePrivate',
        'typedoc.excludeProtected',
        'typedoc.exclude',
      ],
      (intent, intents, entryPoints, name, includeVersion, excludeExternals,
        excludePrivate, excludeProtected, exclude) => hasIntent(intents, intent)
        ? { entryPoints, name, includeVersion, excludeExternals, excludePrivate, excludeProtected, exclude }
        : undefined,
    ),
    typedocGeneratedFiles: rdk.derive(
      ['typedocConfig'],
      config => config === undefined ? {} : { 'typedoc.json': config },
      ['generatedFiles'],
    ),
    ...commandTargets('typedocDocs', 'docs', 'typedoc', {
      export: { '/repo/docs/': 'docs/' },
    }),
  }
  return rdk.graph({
    ...Object.fromEntries(Reflect.ownKeys(inputs).map(key => [key, rdk.value(inputs[key])])),
    ...settings,
  })
}
