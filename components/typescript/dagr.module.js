import di from '//di//dagr.di.js'
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
  return di.module(Object.fromEntries(
    Object.entries(DEFAULT_CONVENTIONS).map(([name, fallback]) => [
      name,
      di.toValue(Object.hasOwn(overrides, name) ? overrides[name] : fallback),
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
  return di.module({
    featureToolPackages: di.toFun(
      [{ tag: 'toolPackages' }],
      contributions => unique(contributionValues(contributions)),
    ),
    featureRuntimePackages: di.toFun(
      [{ tag: 'runtimePackages' }],
      contributions => unique(contributionValues(contributions)),
    ),
    featureAmbientTypes: di.toFun(
      [{ tag: 'ambientTypes' }],
      contributions => unique(contributionValues(contributions)),
    ),
    featureGeneratedFiles: di.toFun(
      [{ tag: 'generatedFiles' }],
      contributions => mergeObjects('generated file', contributionValues(contributions)),
    ),
    featureAllowBuilds: di.toFun(
      [{ tag: 'allowBuilds' }],
      contributions => unique(contributionValues(contributions)),
    ),
    featureVersionDefaults: di.toFun(
      [{ tag: 'versionDefaults' }],
      contributions => mergeVersionCatalogs(contributionValues(contributions)),
    ),
    featureValidations: di.toFun(
      [{ tag: 'validations' }],
      contributions => contributionValues(contributions),
    ),
  })
}

const coreModule = () => di.module({
  versions: di.toFun(
    ['stackVersionDefaults', 'featureVersionDefaults', 'configuredVersions'],
    (stackDefaults, featureDefaults, configured) => ({
      ...stackDefaults,
      ...featureDefaults,
      ...configured,
    }),
  ),
  name: di.toFun(['location', 'scope'], projectName),
  slug: di.toFun(['name'], name => name.slice(name.indexOf('/') + 1)),
  validatedMetadata: di.toFun(['name', 'metadata', 'metadataFields'], validateMetadata),
  sourceLayout: di.toFun(
    ['sourceDirectory', 'entryFile'],
    (directory, entry) => ({ directory, entry }),
  ),
  sourceEntry: di.toFun(['sourceLayout'], layout => `${layout.directory}/${layout.entry}`),
  outputLayout: di.toFun(
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
  distributionIntent: di.toFun(
    ['intent', 'distributionIntents'],
    (intent, intents) => intents.includes(intent),
  ),
  emissionIntent: di.toFun(
    ['productKind', 'intent', 'emissionIntents'],
    (product, intent, intents) => product === 'library' && intents.includes(intent),
  ),
  testSourcesIncluded: di.toFun(
    ['productKind', 'intent', 'testSourceIntents'],
    (product, intent, intents) => product !== 'library' || intents.includes(intent),
  ),
  sourceSet: di.toFun(
    ['productKind', 'sourceLayout', 'testSourcesIncluded'],
    (product, layout, includeTests) => ({
      include: [`${layout.directory}/**/${product === 'web' ? '*' : '*.ts'}`],
      exclude: includeTests
        ? undefined
        : [`${layout.directory}/**/*.test.ts`, `${layout.directory}/**/*.spec.ts`],
    }),
  ),
  runtimeEntry: di.toFun(
    ['productKind', 'distributionIntent', 'sourceEntry', 'outputLayout'],
    (product, distribution, source, output) => product === 'library'
      ? `./${distribution ? output.runtimeFile : source}`
      : undefined,
  ),
  declarationEntry: di.toFun(
    ['productKind', 'distributionIntent', 'sourceEntry', 'outputLayout'],
    (product, distribution, source, output) => product === 'library'
      ? `./${distribution ? output.declarationFile : source}`
      : undefined,
  ),
  emittedArtifacts: di.toFun(
    ['productKind', 'distributionIntent', 'outputLayout'],
    (product, distribution, output) => {
      if (product === 'web') return [output.directory]
      if (product === 'library' && distribution) return [output.directory]
      return []
    },
  ),
  publishable: di.toFun(
    ['intent', 'publicationIntentName'],
    (intent, publication) => intent === publication,
  ),
  sourceMapEmission: di.toFun(
    ['sourceMapIntent', 'emissionIntent'],
    (requested, emitting) => requested && emitting,
  ),
  ambientTypes: di.toFun(['featureAmbientTypes'], types => types),
})

const packageModule = () => di.module({
  dependencyEntries: di.toFun(
    ['name', 'scope', 'deps', 'versions', 'dependencyLocations', 'featureRuntimePackages'],
    dependencyEntries,
  ),
  toolDependencyEntries: di.toFun(['name', 'versions', 'featureToolPackages'], (name, versions, packages) =>
    packages.map(pkg => {
      if (versions[pkg] === undefined) throw new Error(`${name}: no version configured for stack dependency ${pkg}`)
      return [pkg, versions[pkg]]
    })),
  'packageJson.name': di.toFun(['name'], value => value),
  'packageJson.version': di.toFun(['version'], value => value),
  'packageJson.type': di.toFun(
    ['javascriptModuleFormat'],
    format => format === 'esm' ? 'module' : 'commonjs',
  ),
  'packageJson.private': di.toFun(['publishable'], value => !value),
  'packageJson.main': di.toFun(['runtimeEntry'], value => value),
  'packageJson.types': di.toFun(['declarationEntry'], value => value),
  'packageJson.exports': di.toFun(
    ['runtimeEntry', 'declarationEntry'],
    (runtime, declarations) => runtime === undefined
      ? undefined
      : { '.': { types: declarations, import: runtime } },
  ),
  'packageJson.files': di.toFun(
    ['productKind', 'distributionIntent', 'emittedArtifacts'],
    (product, distribution, artifacts) => product === 'library' && distribution ? artifacts : undefined,
  ),
  'packageJson.imports': di.toFun(
    ['importAlias'],
    alias => alias === undefined ? undefined : { [alias.specifier]: alias.runtimePath },
  ),
  'packageJson.dependencies': di.toFun(
    ['dependencyEntries'],
    entries => Object.fromEntries(entries.prod),
  ),
  'packageJson.devDependencies': di.toFun(
    ['intent', 'developmentIntents', 'dependencyEntries', 'toolDependencyEntries'],
    (intent, intents, dependencies, tools) => intents.includes(intent)
      ? Object.fromEntries([...tools, ...dependencies.dev])
      : undefined,
  ),
  packageJson: di.toFun(
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

const tsconfigModule = () => di.module({
  'tsconfig.extends': di.toFun([], () => '@tsconfig/strictest/tsconfig.json'),
  'tsconfig.include': di.toFun(['sourceSet'], value => value.include),
  'tsconfig.exclude': di.toFun(['sourceSet'], value => value.exclude),
  'tsconfig.compilerOptions.rootDir': di.toFun(['sourceLayout'], value => value.directory),
  'tsconfig.compilerOptions.outDir': di.toFun(
    ['emissionIntent', 'outputLayout'],
    (emit, output) => emit ? output.directory : undefined,
  ),
  'tsconfig.compilerOptions.target': di.toFun(['languageTarget'], value => value),
  'tsconfig.compilerOptions.lib': di.toFun(['standardLibraries'], value => value),
  'tsconfig.compilerOptions.module': di.toFun(['moduleKind'], value => value),
  'tsconfig.compilerOptions.moduleResolution': di.toFun(['moduleResolutionKind'], value => value),
  'tsconfig.compilerOptions.noEmit': di.toFun(['emissionIntent'], emit => !emit),
  'tsconfig.compilerOptions.declaration': di.toFun(
    ['productKind', 'emissionIntent'],
    (product, emit) => product === 'library' && emit ? true : undefined,
  ),
  'tsconfig.compilerOptions.sourceMap': di.toFun(
    ['sourceMapEmission'],
    value => value ? true : undefined,
  ),
  'tsconfig.compilerOptions.inlineSources': di.toFun(
    ['sourceMapEmission'],
    value => value ? true : undefined,
  ),
  'tsconfig.compilerOptions.types': di.toFun(
    ['ambientTypes'],
    value => value.length > 0 ? value : undefined,
  ),
  'tsconfig.compilerOptions.paths': di.toFun(
    ['importAlias'],
    alias => alias === undefined ? undefined : { [alias.specifier]: [alias.sourcePath] },
  ),
  'tsconfig.compilerOptions.allowImportingTsExtensions': di.toFun(
    ['productKind'],
    product => product === 'web' ? true : undefined,
  ),
  'tsconfig.compilerOptions.moduleDetection': di.toFun(
    ['productKind'],
    product => product === 'web' ? 'force' : undefined,
  ),
  'tsconfig.compilerOptions.jsx': di.toFun(
    ['productKind'],
    product => product === 'web' ? 'react-jsx' : undefined,
  ),
  compilerOptions: di.toFun(
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
  tsconfig: di.toFun(
    ['tsconfig.extends', 'tsconfig.include', 'tsconfig.exclude', 'compilerOptions'],
    (extendsConfig, include, exclude, compilerOptions) => present([
      ['extends', extendsConfig], ['include', include], ['exclude', exclude], ['compilerOptions', compilerOptions],
    ]),
  ),
})

const workspaceModule = () => di.module({
  files: di.toFun(
    ['packageJson', 'tsconfig', 'featureGeneratedFiles'],
    (packageJson, tsconfig, generated) => ({ 'package.json': packageJson, 'tsconfig.json': tsconfig, ...generated }),
  ),
  allowBuilds: di.toFun(['featureAllowBuilds'], value => value),
  output: di.toFun(['outputLayout'], value => value),
  workspace: di.toFun(
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

export const workspaceKey = (workspace, key) => `${workspace}/${key}`

const workspaceDependency = (workspace, dependency) => typeof dependency === 'object'
  ? { tag: workspaceKey(workspace, dependency.tag) }
  : workspaceKey(workspace, dependency)

function qualifyWorkspace(workspace, module) {
  return di.module(Object.fromEntries([...module.keys()].map(name => {
    const definition = module.definitionOf(name)
    return [workspaceKey(workspace, name), di.toFun(
      definition.deps.map(dependency => workspaceDependency(workspace, dependency)),
      definition.factory,
      definition.tags.map(tag => workspaceKey(workspace, tag)),
    )]
  })))
}

const valueModule = values => di.module(Object.fromEntries(
  Reflect.ownKeys(values).map(name => [name, di.toValue(values[name])]),
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
  const featureSettings = di.module(Object.fromEntries(settingEntries))
  const targets = di.module({ '#dagrRuntime': di.toValue(dagrRuntime) })
    .merge(di.module(Object.fromEntries(targetEntries)))

  const workspaces = new Set(['dev:sync', 'config:dev'])
  for (const name of targets.keys()) {
    const definition = targets.definitionOf(name)
    for (const dependency of definition.deps) {
      if (typeof dependency !== 'string' || !dependency.endsWith('/workspace')) continue
      workspaces.add(dependency.slice(0, -'/workspace'.length))
    }
  }

  let module = targets
  for (const workspace of workspaces) {
    module = module.merge(qualifyWorkspace(
      workspace,
      workspaceTemplate(inputs, intentForWorkspace(workspace), featureSettings, conventions),
    ))
  }
  return module
}
