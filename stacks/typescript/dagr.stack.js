import bundledVersions from '//dagr.versions.yaml'
import di from '//di//dagr.di.js'
import { writeJson, writeText, writeYaml } from '//dagr.file_utils.js'
import { pnpmfile } from '//dagr.utils.js'
import { RECOMMENDED_IGNORE } from '//dagr.dockerignore.js'
import { configFacet, devFacet, facetOf, target } from '//dagr.features.js'
import { typescriptModule } from '//dagr.module.js'

export * from '//dagr.features.js'
export { typescriptModule, workspaceKey } from '//dagr.module.js'
export { di }

function writeProjectedFile(path, value) {
  return typeof value === 'string'
    ? writeText(`/repo/${path}`, value)
    : writeJson(`/repo/${path}`, value)
}

const contributionValues = contributions => Reflect.ownKeys(contributions)
  .map(name => contributions[name])
  .filter(value => value !== undefined)

const collectNamed = (kind, contributions, valueOf = contribution => contribution) => {
  const values = {}
  for (const contribution of contributionValues(contributions)) {
    if (Object.hasOwn(values, contribution.name)) {
      throw new Error(`${kind} ${JSON.stringify(contribution.name)} has more than one owner`)
    }
    values[contribution.name] = valueOf(contribution)
  }
  return values
}

function createStack(options, features, declaration) {
  const {
    base = '//packages/base:ci:node-pnpm',
    scope = 'internal',
    versions = {},
    conventions = {},
    ignore = RECOMMENDED_IGNORE,
    transform = index => index,
  } = options
  const { location, version = '0.1.0', deps = [], metadata = {} } = declaration
  const localDeps = deps.filter(dependency => 'pkg' in dependency)
  const packTarget = dependency => `${dependency.pkg}:ci:pack`
  const dagrRuntime = Object.freeze({
    base,
    ignore,
    localDeps: Object.freeze(localDeps),
    packTarget,
    packTargets: Object.freeze(localDeps.map(packTarget)),
    pnpmfile,
    scope,
    writeJson,
    writeProjectedFile,
    writeText,
    writeYaml,
  })
  let module = typescriptModule({
    location,
    scope,
    version,
    deps,
    metadata,
    versions,
    defaultVersions: bundledVersions.deps,
    features,
    conventions,
    dagrRuntime,
  })

  const facets = Object.freeze({
    ...Object.fromEntries([...module.keys()]
      .map(name => facetOf(module.definitionOf(name)))
      .filter(Boolean)
      .map(facet => [facet.name, facet])),
    [configFacet.name]: configFacet,
    [devFacet.name]: devFacet,
  })
  const facetsTag = Symbol('typescript facets')
  const bindings = {
    coreConfigDevTarget: di.toFun(
      ['config:dev/workspace'],
      workspace => target('dev', {
        deps: [base],
        run: ({ images }) => ({
          FROM: images[base],
          steps: [
            { WORKDIR: '/repo' },
            ...Object.entries(workspace.files).map(([path, value]) => writeProjectedFile(path, value)),
          ],
          IGNORE: ignore,
        }),
      }),
      [configFacet.targets],
    ),
    coreDevSyncTarget: di.toFun(
      ['dev:sync/workspace'],
      workspace => target('sync', {
        deps: ['config:dev'],
        run: ({ images }) => ({
          FROM: images['config:dev'],
          steps: [],
          IGNORE: ignore,
          EXPORT: Object.fromEntries(Object.keys(workspace.files).map(path => [`/repo/${path}`, path])),
        }),
      }),
      [devFacet.targets],
    ),
  }

  for (const facet of Object.values(facets)) {
    bindings[`facet:${facet.name}`] = di.toFun(
      [{ tag: facet.targets }],
      targets => ({ name: facet.name, targets: collectNamed('target', targets) }),
      [facetsTag],
    )
  }

  let calculations
  bindings.index = di.toFun(
    [{ tag: facetsTag }, 'dev:sync/name', 'dev:sync/slug'],
    (facetContributions, name, slug) => transform(
      collectNamed('facet', facetContributions, facet => facet.targets),
      { location, name, slug, calculations, features },
    ),
  )

  module = module.merge(di.module(bindings))
  calculations = Object.freeze({
    nodes: Object.freeze(Object.fromEntries([...module.keys()].map(name => [
      name,
      module.definitionOf(name),
    ]))),
  })

  return module
    .shake(['index'])
    .compile()
    .index
}

function builder(options, features) {
  const stack = declaration => createStack(options, features, declaration)
  return Object.assign(stack, {
    with(next) {
      if (typeof next?.keys !== 'function' || typeof next?.definitionOf !== 'function') {
        throw new Error('with() expects a DI module')
      }
      return builder(options, features.merge(next))
    },
    features,
  })
}

export default function typescript(options = {}) {
  return builder(options, di.module({}))
}
