import rdk from 'dagr:rdk'
import { invocationsFor } from '//dagr.contributions.js'

export const DEVELOPMENT_INTENTS = Object.freeze([
  'dev', 'typecheck', 'test', 'lint', 'docs', 'build',
])
export const DISTRIBUTION_INTENTS = Object.freeze(['pack', 'publish'])

export const present = entries => Object.fromEntries(
  entries.filter(([, value]) => value !== undefined),
)

export const unique = values => [...new Set(values.flat())]

export function projectName(location, scope) {
  if (!location.startsWith('//')) {
    throw new Error(`Expected a logical package location, got ${JSON.stringify(location)}`)
  }
  const path = location.slice(2)
  const relativePath = path.startsWith('packages/') ? path.slice('packages/'.length) : path
  if (!relativePath) throw new Error(`Cannot infer a project name from ${location}`)
  return `@${scope}/${relativePath.replaceAll('/', '-')}`
}

/**
 * Splits `//packages/core:ci` into the package it names and the facet within it. A local dependency
 * identifies a facet, so the package is derived from it rather than declared separately.
 */
export function facetReference(reference) {
  const boundary = reference.lastIndexOf(':')
  const pkg = boundary === -1 ? '' : reference.slice(0, boundary)
  const facet = boundary === -1 ? '' : reference.slice(boundary + 1)
  if (!pkg.startsWith('//') || facet === '' || facet.includes('/')) {
    throw new Error(
      `Expected a local dependency facet as //package:facet, got ${JSON.stringify(reference)}`,
    )
  }
  return Object.freeze({ pkg, facet })
}

/**
 * The facet is declared; choosing `pack` within it is still this recipe's decision, not the
 * dependant's.
 */
export const localPackagesOf = (deps, scope) => Object.freeze(deps
  .filter(dependency => 'facet' in dependency)
  .map(dependency => {
    const name = projectName(facetReference(dependency.facet).pkg, scope)
    return Object.freeze({
      name,
      tarball: `${name.slice(name.indexOf('/') + 1)}.tgz`,
      at: dependency.at,
      target: `${dependency.facet}:pack`,
    })
  }))

/** Resolves a package name against the single version catalog. */
export function versionOf(versions, name) {
  const version = versions[name]
  if (version === undefined) {
    throw new Error(`No version configured for package ${JSON.stringify(name)}`)
  }
  return version
}

/** Projects one canonical binding into an integration or capability path. */
export const adapter = path => rdk.derive(
  { value: rdk.one(path) },
  ({ value }) => value,
)

export function tooling({
  for: intents = DEVELOPMENT_INTENTS,
  packages = [],
  types = [],
  builds = [],
} = {}) {
  if (!Array.isArray(intents) || intents.some(intent => typeof intent !== 'string' || intent === '')) {
    throw new TypeError('tooling for must be an array of intent names')
  }
  if (!Array.isArray(packages) || packages.some(name => typeof name !== 'string' || name === '')) {
    throw new TypeError('tooling packages must be an array of package names')
  }
  if (!Array.isArray(types) || types.some(name => typeof name !== 'string' || name === '')) {
    throw new TypeError('tooling types must be an array of type names')
  }
  if (!Array.isArray(builds) || builds.some(name => typeof name !== 'string' || name === '')) {
    throw new TypeError('tooling builds must be an array of package names')
  }
  return rdk.value(Object.freeze({
    for: Object.freeze([...intents]),
    packages: Object.freeze([...packages]),
    types: Object.freeze([...types]),
    builds: Object.freeze([...builds]),
  }))
}

const toolingProjection = (path, field) => rdk.derive(
  { tooling: rdk.one(path) },
  ({ tooling: contribution }) => Object.freeze({
    for: contribution.for,
    values: contribution[field],
  }),
)

export const packageJsonDependencies = path => toolingProjection(path, 'packages')
export const tsconfigTypes = path => toolingProjection(path, 'types')
export const packageManagerBuilds = path => toolingProjection(path, 'builds')

const valuesFor = (contributions, intent) => unique(
  Reflect.ownKeys(contributions)
    .map(name => contributions[name])
    .filter(contribution => contribution.for.includes(intent))
    .flatMap(contribution => contribution.values),
)

export const packagesFor = (contributions, context, versions) => Object.freeze(Object.fromEntries(
  valuesFor(contributions, context.intent).map(name => [name, versionOf(versions, name)]),
))

export const typesFor = (contributions, context) => Object.freeze(
  valuesFor(contributions, context.intent),
)

export const buildsFor = (contributions, intent) => valuesFor(contributions, intent)

/**
 * Materializes invocations as container steps. `exec` resolves an installed binary, which a
 * container needs and a package-manager script does not.
 */
export const runSteps = (invocations, exec) => invocations.map(invocation => ({
  RUN: invocation.tool === undefined ? invocation.shell : exec(invocation.tool),
}))

/** Materializes the same invocations as package-manager scripts, one per intent that runs any. */
export const scriptsFor = (contributions, script) => present(DEVELOPMENT_INTENTS.map(intent => {
  const invocations = invocationsFor(contributions, intent)
  return [intent, invocations.length === 0
    ? undefined
    : invocations.map(invocation => invocation.tool === undefined
        ? invocation.shell
        : script(invocation.tool)).join(' && ')]
}))

export const copyLocalPackages = (localPackages, images, destination = '/repo') => localPackages.map(pkg => ({
  COPY: { from: images[pkg.target], src: '/out', dest: destination },
}))

export const copySource = directory => ({ COPY: { src: directory, dest: `/repo/${directory}` } })
export const copyAssets = assets => assets.map(path => ({ COPY: { src: path, dest: `/repo/${path}` } }))
