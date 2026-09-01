const node = (kind, deps = [], factory) => Object.freeze({
  kind,
  deps: Object.freeze([...deps]),
  ...(factory === undefined ? {} : { factory }),
})

const external = () => node('external')
const target = () => node('target')
const calculated = (deps, factory) => node('calculated', deps, factory)

function compile(graph, di, externalValues, targetValues, roots) {
  const sourceModule = kind => di.module(Object.fromEntries(
    Object.entries(graph.nodes)
      .filter(([, definition]) => definition.kind === kind)
      .map(([name]) => {
        const values = kind === 'external' ? externalValues : targetValues
        if (!Object.hasOwn(values, name)) {
          throw new Error(`Missing ${kind} calculation node ${JSON.stringify(name)}`)
        }
        return [name, di.toValue(values[name])]
      }),
  ))
  const calculations = di.module(Object.fromEntries(
    Object.entries(graph.nodes)
      .filter(([, definition]) => definition.kind === 'calculated')
      .map(([name, definition]) => [name, di.toFun(definition.deps, definition.factory)]),
  ))

  return sourceModule('external')
    .merge(sourceModule('target'))
    .merge(calculations)
    .shake(roots)
    .compile()
}

export function projectName(location, scope) {
  if (!location.startsWith('//')) {
    throw new Error(`Expected a logical package location, got ${JSON.stringify(location)}`)
  }

  const path = location.slice(2)
  const relativePath = path.startsWith('packages/') ? path.slice('packages/'.length) : path
  if (!relativePath) throw new Error(`Cannot infer a project name from ${location}`)
  return `@${scope}/${relativePath.replaceAll('/', '-')}`
}

const POLICY = Object.freeze({
  targetActions: Object.freeze({
    'config:dev': 'dev',
    'config:typecheck': 'typecheck',
    'config:test': 'test',
    'config:build': 'build',
    'dev:sync': 'dev',
    'ci:install-typecheck': 'typecheck',
    'ci:install-test': 'test',
    'ci:install-build': 'build',
    'ci:typecheck': 'typecheck',
    'ci:test': 'test',
    'ci:build': 'build',
    'ci:pack': 'pack',
    'publish:pack': 'publish',
  }),
  developmentActions: Object.freeze(['dev', 'typecheck', 'test', 'build']),
  distributionActions: Object.freeze(['pack', 'publish']),
  emitActions: Object.freeze(['build', 'pack', 'publish']),
  vitestActions: Object.freeze(['dev', 'test']),
  prettierActions: Object.freeze(['dev']),
  publishAction: 'publish',
  dependencyLocations: Object.freeze(['prod', 'dev']),
  toolDependencies: Object.freeze({
    dev: Object.freeze(['@tsconfig/strictest', 'prettier', 'typescript', 'vitest']),
    typecheck: Object.freeze(['@tsconfig/strictest', 'typescript', 'vitest']),
    test: Object.freeze(['@tsconfig/strictest', 'typescript', 'vitest']),
    build: Object.freeze(['@tsconfig/strictest', 'typescript']),
    pack: Object.freeze([]),
    publish: Object.freeze([]),
  }),
  metadataFields: Object.freeze([
    'author',
    'bugs',
    'contributors',
    'description',
    'funding',
    'homepage',
    'keywords',
    'license',
    'repository',
  ]),
  sourceDirectory: 'src',
  entryFile: 'index.ts',
  outputDirectory: 'dist',
  moduleType: 'module',
  typescriptPolicy: Object.freeze({
    extends: '@tsconfig/strictest/tsconfig.json',
    target: 'ES2022',
    lib: Object.freeze(['ES2022']),
    module: 'ESNext',
    moduleResolution: 'Bundler',
  }),
  prettierPolicy: Object.freeze({
    $schema: 'https://json.schemastore.org/prettierrc',
    semi: false,
    tabWidth: 2,
    singleQuote: true,
    printWidth: 100,
    trailingComma: 'none',
  }),
})

const validateMetadata = (name, metadata, metadataFields) => {
  const conflicts = Object.keys(metadata).filter(field => !metadataFields.includes(field))
  if (conflicts.length > 0) {
    const plural = conflicts.length === 1 ? '' : 's'
    throw new Error(`${name}: package metadata cannot configure non-metadata field${plural} ${conflicts.join(', ')}`)
  }
  return metadata
}

const dependencyEntries = (name, scope, deps, versions, dependencyLocations) => {
  for (const dependency of deps) {
    const sources = ['pkg', 'npm'].filter(source => source in dependency)
    if (sources.length !== 1) {
      throw new Error(`${name}: dependency needs exactly one of pkg or npm`)
    }
    if (!dependencyLocations.includes(dependency.at)) {
      throw new Error(`${name}: dependency ${dependency.pkg ?? dependency.npm} needs at ${dependencyLocations.join(' or ')}, got ${JSON.stringify(dependency.at)}`)
    }
    if ('npm' in dependency && versions[dependency.npm] === undefined) {
      throw new Error(`${name}: no version configured for npm dependency ${dependency.npm}`)
    }
  }

  const entry = dependency => 'pkg' in dependency
    ? [projectName(dependency.pkg, scope), '>=0.0.0']
    : [dependency.npm, versions[dependency.npm]]
  const at = location => deps.filter(dependency => dependency.at === location).map(entry)
  return { prod: at('prod'), dev: at('dev') }
}

const toolDependencyEntries = (name, action, toolDependencies, versions) =>
  toolDependencies[action].map(pkg => {
    if (versions[pkg] === undefined) {
      throw new Error(`${name}: no version configured for stack dependency ${pkg}`)
    }
    return [pkg, versions[pkg]]
  })

export const TYPESCRIPT_LIBRARY_DAG = Object.freeze({ nodes: Object.freeze({
  // Values originating outside this calculation graph.
  location: external(),
  scope: external(),
  version: external(),
  deps: external(),
  metadata: external(),
  versions: external(),
  testEnvironment: external(),
  targetActions: external(),
  developmentActions: external(),
  distributionActions: external(),
  emitActions: external(),
  vitestActions: external(),
  prettierActions: external(),
  publishAction: external(),
  dependencyLocations: external(),
  toolDependencies: external(),
  metadataFields: external(),
  sourceDirectory: external(),
  entryFile: external(),
  outputDirectory: external(),
  moduleType: external(),
  typescriptPolicy: external(),
  prettierPolicy: external(),

  // The dagr target requesting a projection.
  target: target(),

  // Every remaining node declares its incoming edges explicitly.
  action: calculated(['target', 'targetActions'], (selectedTarget, targetActions) => {
    const action = targetActions[selectedTarget]
    if (action === undefined) {
      throw new Error(`Unknown TypeScript library target ${JSON.stringify(selectedTarget)}`)
    }
    return action
  }),
  name: calculated(['location', 'scope'], projectName),
  slug: calculated(['name'], name => name.slice(name.indexOf('/') + 1)),
  validatedMetadata: calculated(['name', 'metadata', 'metadataFields'], validateMetadata),
  dependencyEntries: calculated(
    ['name', 'scope', 'deps', 'versions', 'dependencyLocations'],
    dependencyEntries,
  ),
  toolDependencyEntries: calculated(
    ['name', 'action', 'toolDependencies', 'versions'],
    toolDependencyEntries,
  ),
  dependencyFields: calculated(
    ['action', 'developmentActions', 'dependencyEntries', 'toolDependencyEntries'],
    (action, developmentActions, dependencies, tools) => ({
      dependencies: Object.fromEntries(dependencies.prod),
      ...(developmentActions.includes(action)
        ? { devDependencies: Object.fromEntries([...tools, ...dependencies.dev]) }
        : {}),
    }),
  ),
  sourceEntry: calculated(
    ['sourceDirectory', 'entryFile'],
    (sourceDirectory, entryFile) => `${sourceDirectory}/${entryFile}`,
  ),
  outputStem: calculated(['entryFile'], entryFile => entryFile.replace(/\.[^.]+$/, '')),
  sourceImport: calculated(['sourceEntry'], sourceEntry => `./${sourceEntry}`),
  outputImport: calculated(
    ['outputDirectory', 'outputStem'],
    (outputDirectory, outputStem) => `./${outputDirectory}/${outputStem}.js`,
  ),
  outputTypes: calculated(
    ['outputDirectory', 'outputStem'],
    (outputDirectory, outputStem) => `./${outputDirectory}/${outputStem}.d.ts`,
  ),
  distribution: calculated(
    ['action', 'distributionActions'],
    (action, distributionActions) => distributionActions.includes(action),
  ),
  emit: calculated(
    ['action', 'emitActions'],
    (action, emitActions) => emitActions.includes(action),
  ),
  publishable: calculated(
    ['action', 'publishAction'],
    (action, publishAction) => action === publishAction,
  ),
  importPath: calculated(
    ['distribution', 'sourceImport', 'outputImport'],
    (distribution, sourceImport, outputImport) => distribution ? outputImport : sourceImport,
  ),
  typesPath: calculated(
    ['distribution', 'sourceImport', 'outputTypes'],
    (distribution, sourceImport, outputTypes) => distribution ? outputTypes : sourceImport,
  ),
  packageJson: calculated(
    [
      'validatedMetadata',
      'name',
      'version',
      'moduleType',
      'publishable',
      'importPath',
      'typesPath',
      'distribution',
      'outputDirectory',
      'dependencyFields',
    ],
    (metadata, name, version, moduleType, publishable, importPath, typesPath,
      distribution, outputDirectory, dependencies) => ({
      ...metadata,
      name,
      version,
      type: moduleType,
      private: !publishable,
      main: importPath,
      types: typesPath,
      exports: { '.': { types: typesPath, import: importPath } },
      ...(distribution ? { files: [outputDirectory] } : {}),
      ...dependencies,
    }),
  ),
  tsconfig: calculated(
    ['typescriptPolicy', 'sourceDirectory', 'outputDirectory', 'emit'],
    (policy, sourceDirectory, outputDirectory, emit) => ({
      extends: policy.extends,
      include: [`${sourceDirectory}/**/*`],
      ...(emit
        ? { exclude: [`${sourceDirectory}/**/*.test.ts`, `${sourceDirectory}/**/*.spec.ts`] }
        : {}),
      compilerOptions: {
        rootDir: sourceDirectory,
        target: policy.target,
        lib: policy.lib,
        module: policy.module,
        moduleResolution: policy.moduleResolution,
        ...(emit
          ? { outDir: outputDirectory, declaration: true, noEmit: false }
          : { noEmit: true }),
      },
    }),
  ),
  vitestConfig: calculated(
    ['action', 'vitestActions', 'testEnvironment'],
    (action, vitestActions, environment) => vitestActions.includes(action)
      ? `export default ${JSON.stringify({ test: { environment } }, null, 2)}\n`
      : undefined,
  ),
  prettierConfig: calculated(
    ['action', 'prettierActions', 'prettierPolicy'],
    (action, prettierActions, policy) => prettierActions.includes(action) ? policy : undefined,
  ),
  files: calculated(
    ['packageJson', 'tsconfig', 'vitestConfig', 'prettierConfig'],
    (packageJson, tsconfig, vitestConfig, prettierConfig) => ({
      'package.json': packageJson,
      'tsconfig.json': tsconfig,
      ...(prettierConfig === undefined ? {} : { '.prettierrc.json': prettierConfig }),
      ...(vitestConfig === undefined ? {} : { 'vitest.config.js': vitestConfig }),
    }),
  ),
  output: calculated(
    ['outputDirectory', 'outputImport', 'outputTypes'],
    (directory, importPath, types) => ({ directory, import: importPath, types }),
  ),
  projection: calculated(
    ['target', 'action', 'name', 'slug', 'packageJson', 'tsconfig', 'files', 'output'],
    (selectedTarget, action, name, slug, packageJson, tsconfig, files, output) => ({
      target: selectedTarget,
      action,
      name,
      slug,
      packageJson,
      tsconfig,
      files,
      output,
    }),
  ),
}) })

export function typescriptLibraryProjector(di, {
  location,
  scope,
  version,
  deps = [],
  metadata = {},
  versions,
  testEnvironment = 'node',
}) {
  const externalValues = {
    ...POLICY,
    location,
    scope,
    version,
    deps,
    metadata,
    versions,
    testEnvironment,
  }

  return selectedTarget => compile(
    TYPESCRIPT_LIBRARY_DAG,
    di,
    externalValues,
    { target: selectedTarget },
    ['projection'],
  ).projection
}
