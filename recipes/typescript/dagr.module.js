import rdk from '//rdk//dagr.rdk.js'
import { facetOf } from '//dagr.features.js'

const DEFAULT_CONVENTIONS = Object.freeze({
  developmentIntents: Object.freeze(['dev', 'typecheck', 'test', 'lint', 'docs', 'build']),
  distributionIntents: Object.freeze(['pack', 'publish']),
  emissionIntents: Object.freeze(['build', 'pack', 'publish']),
  testSourceIntents: Object.freeze(['dev', 'test', 'lint']),
  developmentIntentName: 'dev',
  publicationIntentName: 'publish',
  dependencyLocations: Object.freeze(['prod', 'dev']),
  metadataFields: Object.freeze([
    'author', 'bugs', 'contributors', 'description', 'funding', 'homepage', 'keywords', 'license', 'repository',
  ]),
  sourceDirectory: 'src',
  entryFile: 'index.ts',
  outputDirectory: 'dist',
  javascriptModuleFormat: 'esm',
})

function conventionModule(overrides = {}) {
  const unknown = Object.keys(overrides).filter(name => !Object.hasOwn(DEFAULT_CONVENTIONS, name))
  if (unknown.length > 0) {
    throw new Error(`Unknown TypeScript convention${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}`)
  }
  return rdk.graph(Object.fromEntries(
    Object.entries(DEFAULT_CONVENTIONS).map(([name, fallback]) => [
      name,
      rdk.value(Object.hasOwn(overrides, name) ? overrides[name] : fallback),
    ]),
  ))
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

const unique = values => [...new Set(values.flat())]

const mergeObjects = (label, values) => {
  const result = {}
  for (const value of values) {
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(result, key)) {
        throw new Error(`${label} contribution ${JSON.stringify(key)} has more than one owner`)
      }
      result[key] = entry
    }
  }
  return result
}

const present = entries => Object.fromEntries(entries.filter(([, value]) => value !== undefined))

const validateMetadata = (name, metadata, metadataFields) => {
  const conflicts = Object.keys(metadata).filter(field => !metadataFields.includes(field))
  if (conflicts.length > 0) {
    const plural = conflicts.length === 1 ? '' : 's'
    throw new Error(`${name}: package metadata cannot configure non-metadata field${plural} ${conflicts.join(', ')}`)
  }
  return metadata
}

const dependencyEntries = (name, scope, deps, versions, dependencyLocations, runtimePackages) => {
  for (const dependency of deps) {
    const sources = ['pkg', 'npm'].filter(source => source in dependency)
    if (sources.length !== 1) throw new Error(`${name}: dependency needs exactly one of pkg or npm`)
    if (!dependencyLocations.includes(dependency.at)) {
      throw new Error(`${name}: dependency ${dependency.pkg ?? dependency.npm} needs at ${dependencyLocations.join(' or ')}, got ${JSON.stringify(dependency.at)}`)
    }
    if ('npm' in dependency && versions[dependency.npm] === undefined) {
      throw new Error(`${name}: no version configured for npm dependency ${dependency.npm}`)
    }
  }
  for (const pkg of runtimePackages) {
    if (versions[pkg] === undefined) {
      throw new Error(`${name}: no version configured for stack runtime dependency ${pkg}`)
    }
  }
  const entry = dependency => 'pkg' in dependency
    ? [projectName(dependency.pkg, scope), '>=0.0.0']
    : [dependency.npm, versions[dependency.npm]]
  const at = location => deps.filter(dependency => dependency.at === location).map(entry)
  return {
    prod: [...runtimePackages.map(pkg => [pkg, versions[pkg]]), ...at('prod')],
    dev: at('dev'),
  }
}

const contributionValues = contributions => Reflect.ownKeys(contributions)
  .map(name => contributions[name])

const mergeVersionCatalogs = catalogs => {
  const versions = {}
  for (const catalog of catalogs) {
    for (const [name, version] of Object.entries(catalog)) {
      if (Object.hasOwn(versions, name) && versions[name] !== version) {
        throw new Error(`Default version for ${JSON.stringify(name)} has conflicting owners`)
      }
      versions[name] = version
    }
  }
  return versions
}

function aggregateModule() {
  return rdk.graph({
    featureToolPackages: rdk.derive(
      [{ tag: 'toolPackages' }],
      contributions => unique(contributionValues(contributions)),
    ),
    featureRuntimePackages: rdk.derive(
      [{ tag: 'runtimePackages' }],
      contributions => unique(contributionValues(contributions)),
    ),
    featureAmbientTypes: rdk.derive(
      [{ tag: 'ambientTypes' }],
      contributions => unique(contributionValues(contributions)),
    ),
    featureGeneratedFiles: rdk.derive(
      [{ tag: 'generatedFiles' }],
      contributions => mergeObjects('generated file', contributionValues(contributions)),
    ),
    featureAllowBuilds: rdk.derive(
      [{ tag: 'allowBuilds' }],
      contributions => unique(contributionValues(contributions)),
    ),
    featureVersionDefaults: rdk.derive(
      [{ tag: 'versionDefaults' }],
      contributions => mergeVersionCatalogs(contributionValues(contributions)),
    ),
    featureValidations: rdk.derive(
      [{ tag: 'validations' }],
      contributions => contributionValues(contributions),
    ),
  })
}

const coreModule = () => rdk.graph({
  versions: rdk.derive(
    ['stackVersionDefaults', 'featureVersionDefaults', 'configuredVersions'],
    (stackDefaults, featureDefaults, configured) => ({
      ...stackDefaults,
      ...featureDefaults,
      ...configured,
    }),
  ),
  name: rdk.derive(['location', 'scope'], projectName),
  slug: rdk.derive(['name'], name => name.slice(name.indexOf('/') + 1)),
  validatedMetadata: rdk.derive(['name', 'metadata', 'metadataFields'], validateMetadata),
  sourceLayout: rdk.derive(
    ['sourceDirectory', 'entryFile'],
    (directory, entry) => ({ directory, entry }),
  ),
  sourceEntry: rdk.derive(['sourceLayout'], layout => `${layout.directory}/${layout.entry}`),
  outputLayout: rdk.derive(
    ['productKind', 'outputDirectory', 'entryFile'],
    (product, directory, entry) => {
      if (product === 'worker') return undefined
      if (product === 'web') return { directory }
      const stem = entry.replace(/\.[^.]+$/, '')
      return {
        directory,
        runtimeFile: `${directory}/${stem}.js`,
        declarationFile: `${directory}/${stem}.d.ts`,
      }
    },
  ),
  distributionIntent: rdk.derive(
    ['intent', 'distributionIntents'],
    (intent, intents) => intents.includes(intent),
  ),
  emissionIntent: rdk.derive(
    ['productKind', 'intent', 'emissionIntents'],
    (product, intent, intents) => product === 'library' && intents.includes(intent),
  ),
  testSourcesIncluded: rdk.derive(
    ['productKind', 'intent', 'testSourceIntents'],
    (product, intent, intents) => product !== 'library' || intents.includes(intent),
  ),
  sourceSet: rdk.derive(
    ['productKind', 'sourceLayout', 'testSourcesIncluded'],
    (product, layout, includeTests) => ({
      include: [`${layout.directory}/**/${product === 'web' ? '*' : '*.ts'}`],
      exclude: includeTests
        ? undefined
        : [`${layout.directory}/**/*.test.ts`, `${layout.directory}/**/*.spec.ts`],
    }),
  ),
  runtimeEntry: rdk.derive(
    ['productKind', 'distributionIntent', 'sourceEntry', 'outputLayout'],
    (product, distribution, source, output) => product === 'library'
      ? `./${distribution ? output.runtimeFile : source}`
      : undefined,
  ),
  declarationEntry: rdk.derive(
    ['productKind', 'distributionIntent', 'sourceEntry', 'outputLayout'],
    (product, distribution, source, output) => product === 'library'
      ? `./${distribution ? output.declarationFile : source}`
      : undefined,
  ),
  emittedArtifacts: rdk.derive(
    ['productKind', 'distributionIntent', 'outputLayout'],
    (product, distribution, output) => {
      if (product === 'web') return [output.directory]
      if (product === 'library' && distribution) return [output.directory]
      return []
    },
  ),
  publishable: rdk.derive(
    ['intent', 'publicationIntentName'],
    (intent, publication) => intent === publication,
  ),
  sourceMapEmission: rdk.derive(
    ['sourceMapIntent', 'emissionIntent'],
    (requested, emitting) => requested && emitting,
  ),
  ambientTypes: rdk.derive(['featureAmbientTypes'], types => types),
})

const packageModule = () => rdk.graph({
  dependencyEntries: rdk.derive(
    ['name', 'scope', 'deps', 'versions', 'dependencyLocations', 'featureRuntimePackages'],
    dependencyEntries,
  ),
  toolDependencyEntries: rdk.derive(['name', 'versions', 'featureToolPackages'], (name, versions, packages) =>
    packages.map(pkg => {
      if (versions[pkg] === undefined) throw new Error(`${name}: no version configured for stack dependency ${pkg}`)
      return [pkg, versions[pkg]]
    })),
  'packageJson.name': rdk.derive(['name'], value => value),
  'packageJson.version': rdk.derive(['version'], value => value),
  'packageJson.type': rdk.derive(
    ['javascriptModuleFormat'],
    format => format === 'esm' ? 'module' : 'commonjs',
  ),
  'packageJson.private': rdk.derive(['publishable'], value => !value),
  'packageJson.main': rdk.derive(['runtimeEntry'], value => value),
  'packageJson.types': rdk.derive(['declarationEntry'], value => value),
  'packageJson.exports': rdk.derive(
    ['runtimeEntry', 'declarationEntry'],
    (runtime, declarations) => runtime === undefined
      ? undefined
      : { '.': { types: declarations, import: runtime } },
  ),
  'packageJson.files': rdk.derive(
    ['productKind', 'distributionIntent', 'emittedArtifacts'],
    (product, distribution, artifacts) => product === 'library' && distribution ? artifacts : undefined,
  ),
  'packageJson.imports': rdk.derive(
    ['importAlias'],
    alias => alias === undefined ? undefined : { [alias.specifier]: alias.runtimePath },
  ),
  'packageJson.dependencies': rdk.derive(
    ['dependencyEntries'],
    entries => Object.fromEntries(entries.prod),
  ),
  'packageJson.devDependencies': rdk.derive(
    ['intent', 'developmentIntents', 'dependencyEntries', 'toolDependencyEntries'],
    (intent, intents, dependencies, tools) => intents.includes(intent)
      ? Object.fromEntries([...tools, ...dependencies.dev])
      : undefined,
  ),
  packageJson: rdk.derive(
    [
      'validatedMetadata',
      'packageJson.name',
      'packageJson.version',
      'packageJson.type',
      'packageJson.private',
      'packageJson.main',
      'packageJson.types',
      'packageJson.exports',
      'packageJson.files',
      'packageJson.imports',
      'packageJson.dependencies',
      'packageJson.devDependencies',
    ],
    (metadata, name, version, type, isPrivate, main, types, exports, files, imports,
      dependencies, devDependencies) => ({
      ...metadata,
      ...present([
        ['name', name], ['version', version], ['type', type], ['private', isPrivate],
        ['main', main], ['types', types], ['exports', exports], ['files', files], ['imports', imports],
        ['dependencies', dependencies], ['devDependencies', devDependencies],
      ]),
    }),
  ),
})

const tsconfigModule = () => rdk.graph({
  'tsconfig.extends': rdk.derive([], () => '@tsconfig/strictest/tsconfig.json'),
  'tsconfig.include': rdk.derive(['sourceSet'], value => value.include),
  'tsconfig.exclude': rdk.derive(['sourceSet'], value => value.exclude),
  'tsconfig.compilerOptions.rootDir': rdk.derive(['sourceLayout'], value => value.directory),
  'tsconfig.compilerOptions.outDir': rdk.derive(
    ['emissionIntent', 'outputLayout'],
    (emit, output) => emit ? output.directory : undefined,
  ),
  'tsconfig.compilerOptions.target': rdk.derive(['languageTarget'], value => value),
  'tsconfig.compilerOptions.lib': rdk.derive(['standardLibraries'], value => value),
  'tsconfig.compilerOptions.module': rdk.derive(['moduleKind'], value => value),
  'tsconfig.compilerOptions.moduleResolution': rdk.derive(['moduleResolutionKind'], value => value),
  'tsconfig.compilerOptions.noEmit': rdk.derive(['emissionIntent'], emit => !emit),
  'tsconfig.compilerOptions.declaration': rdk.derive(
    ['productKind', 'emissionIntent'],
    (product, emit) => product === 'library' && emit ? true : undefined,
  ),
  'tsconfig.compilerOptions.sourceMap': rdk.derive(
    ['sourceMapEmission'],
    value => value ? true : undefined,
  ),
  'tsconfig.compilerOptions.inlineSources': rdk.derive(
    ['sourceMapEmission'],
    value => value ? true : undefined,
  ),
  'tsconfig.compilerOptions.types': rdk.derive(
    ['ambientTypes'],
    value => value.length > 0 ? value : undefined,
  ),
  'tsconfig.compilerOptions.paths': rdk.derive(
    ['importAlias'],
    alias => alias === undefined ? undefined : { [alias.specifier]: [alias.sourcePath] },
  ),
  'tsconfig.compilerOptions.allowImportingTsExtensions': rdk.derive(
    ['productKind'],
    product => product === 'web' ? true : undefined,
  ),
  'tsconfig.compilerOptions.moduleDetection': rdk.derive(
    ['productKind'],
    product => product === 'web' ? 'force' : undefined,
  ),
  'tsconfig.compilerOptions.jsx': rdk.derive(
    ['productKind'],
    product => product === 'web' ? 'react-jsx' : undefined,
  ),
  compilerOptions: rdk.derive(
    [
      'tsconfig.compilerOptions.rootDir',
      'tsconfig.compilerOptions.outDir',
      'tsconfig.compilerOptions.target',
      'tsconfig.compilerOptions.lib',
      'tsconfig.compilerOptions.module',
      'tsconfig.compilerOptions.moduleResolution',
      'tsconfig.compilerOptions.noEmit',
      'tsconfig.compilerOptions.declaration',
      'tsconfig.compilerOptions.sourceMap',
      'tsconfig.compilerOptions.inlineSources',
      'tsconfig.compilerOptions.types',
      'tsconfig.compilerOptions.paths',
      'tsconfig.compilerOptions.allowImportingTsExtensions',
      'tsconfig.compilerOptions.moduleDetection',
      'tsconfig.compilerOptions.jsx',
    ],
    (rootDir, outDir, target, lib, module, moduleResolution, noEmit, declaration,
      sourceMap, inlineSources, types, paths, allowImportingTsExtensions, moduleDetection, jsx) => present([
      ['rootDir', rootDir], ['outDir', outDir], ['target', target], ['lib', lib], ['module', module],
      ['moduleResolution', moduleResolution], ['noEmit', noEmit], ['declaration', declaration],
      ['sourceMap', sourceMap], ['inlineSources', inlineSources], ['types', types], ['paths', paths],
      ['allowImportingTsExtensions', allowImportingTsExtensions],
      ['moduleDetection', moduleDetection], ['jsx', jsx],
    ]),
  ),
  tsconfig: rdk.derive(
    ['tsconfig.extends', 'tsconfig.include', 'tsconfig.exclude', 'compilerOptions'],
    (extendsConfig, include, exclude, compilerOptions) => present([
      ['extends', extendsConfig], ['include', include], ['exclude', exclude], ['compilerOptions', compilerOptions],
    ]),
  ),
})

const workspaceModule = () => rdk.graph({
  files: rdk.derive(
    ['packageJson', 'tsconfig', 'featureGeneratedFiles'],
    (packageJson, tsconfig, generated) => ({ 'package.json': packageJson, 'tsconfig.json': tsconfig, ...generated }),
  ),
  allowBuilds: rdk.derive(['featureAllowBuilds'], value => value),
  output: rdk.derive(['outputLayout'], value => value),
  workspace: rdk.derive(
    [
      'intent', 'name', 'slug', 'packageJson', 'tsconfig', 'files', 'output',
      'allowBuilds', 'buildAssets', 'sourceLayout', 'sourceSet', 'runtimeEntry',
      'declarationEntry', 'emittedArtifacts', 'featureValidations',
    ],
    (intent, name, slug, packageJson, tsconfig, files, output,
      allowBuilds, buildAssets, sourceLayout, sourceSet, runtimeEntry, declarationEntry,
      emittedArtifacts, _validations) => ({
      intent,
      name,
      slug,
      packageJson,
      tsconfig,
      files,
      output,
      allowBuilds,
      buildAssets,
      semantics: { sourceLayout, sourceSet, outputLayout: output, runtimeEntry, declarationEntry, emittedArtifacts },
    }),
  ),
})

const workspaceSymbols = new Map()

export function workspaceKey(workspace, key) {
  if (typeof key !== 'symbol') return `${workspace}/${key}`
  let symbols = workspaceSymbols.get(workspace)
  if (symbols === undefined) {
    symbols = new Map()
    workspaceSymbols.set(workspace, symbols)
  }
  if (!symbols.has(key)) {
    symbols.set(key, Symbol(`${workspace}/${key.description ?? ''}`))
  }
  return symbols.get(key)
}

const workspaceDependency = (workspace, dependency) => typeof dependency === 'object'
  ? { tag: workspaceKey(workspace, dependency.tag) }
  : workspaceKey(workspace, dependency)

function qualifyWorkspace(workspace, graph) {
  return rdk.graph(Object.fromEntries([...graph.keys()].map(name => {
    const definition = graph.definitionOf(name)
    return [workspaceKey(workspace, name), rdk.derive(
      definition.deps.map(dependency => workspaceDependency(workspace, dependency)),
      definition.factory,
      definition.tags.map(tag => workspaceKey(workspace, tag)),
    )]
  })))
}

const valueModule = values => rdk.graph(Object.fromEntries(
  Reflect.ownKeys(values).map(name => [name, rdk.value(values[name])]),
))

const workspaceTemplate = (inputs, intent, features, conventions) => valueModule({ ...inputs, intent })
  .merge(conventionModule(conventions))
  .merge(coreModule())
  .merge(aggregateModule())
  .merge(packageModule())
  .merge(tsconfigModule())
  .merge(workspaceModule())
  .merge(features)

const intentForWorkspace = workspace => {
  const [facet, name] = workspace.split(':', 2)
  if (facet === 'publish') return 'publish'
  if (facet === 'dev' || name === 'dev') return 'dev'
  return name
}

export function typescriptModule({
  location,
  scope,
  version,
  deps = [],
  metadata = {},
  versions,
  defaultVersions = {},
  features,
  conventions = {},
  dagrRuntime,
}) {
  const inputs = {
    location,
    scope,
    version,
    deps,
    metadata,
    configuredVersions: versions ?? {},
    stackVersionDefaults: defaultVersions,
  }

  const settingEntries = []
  const targetEntries = []
  for (const name of features.keys()) {
    const definition = features.definitionOf(name)
    const entries = facetOf(definition) ? targetEntries : settingEntries
    entries.push([name, definition])
  }
  const featureSettings = rdk.graph(Object.fromEntries(settingEntries))
  const targets = rdk.graph({ '#dagrRuntime': rdk.value(dagrRuntime) })
    .merge(rdk.graph(Object.fromEntries(targetEntries)))

  const workspaces = new Set(['dev:sync', 'config:dev'])
  for (const name of targets.keys()) {
    const definition = targets.definitionOf(name)
    for (const dependency of definition.deps) {
      if (typeof dependency !== 'string' || !dependency.endsWith('/workspace')) continue
      workspaces.add(dependency.slice(0, -'/workspace'.length))
    }
  }

  let graph = targets
  for (const workspace of workspaces) {
    graph = graph.merge(qualifyWorkspace(
      workspace,
      workspaceTemplate(inputs, intentForWorkspace(workspace), featureSettings, conventions),
    ))
  }
  return graph
}
