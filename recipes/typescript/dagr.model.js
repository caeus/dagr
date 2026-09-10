import rdk from '//rdk//dagr.rdk.js'

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

export const localPackagesOf = (deps, scope) => Object.freeze(deps
  .filter(dependency => 'pkg' in dependency)
  .map(dependency => {
    const name = projectName(dependency.pkg, scope)
    return Object.freeze({
      name,
      tarball: `${name.slice(name.indexOf('/') + 1)}.tgz`,
      at: dependency.at,
      target: `${dependency.pkg}:ci:pack`,
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

export function requirement({
  for: intents = DEVELOPMENT_INTENTS,
  packages = [],
  types = [],
  allowBuilds = [],
} = {}) {
  if (!Array.isArray(intents) || intents.some(intent => typeof intent !== 'string' || intent === '')) {
    throw new TypeError('requirement for must be an array of intent names')
  }
  if (!Array.isArray(packages) || packages.some(name => typeof name !== 'string' || name === '')) {
    throw new TypeError('requirement packages must be an array of package names')
  }
  if (!Array.isArray(types) || !Array.isArray(allowBuilds)) {
    throw new TypeError('requirement types and allowBuilds must be arrays')
  }
  return rdk.value(Object.freeze({
    for: Object.freeze([...intents]),
    packages: Object.freeze([...packages]),
    types: Object.freeze([...types]),
    allowBuilds: Object.freeze([...allowBuilds]),
  }))
}

export function requirementsOf(contributions, context, versions) {
  const packages = []
  const types = []
  const allowBuilds = []

  for (const contribution of Reflect.ownKeys(contributions).map(name => contributions[name])) {
    if (!contribution.for.includes(context.intent)) continue
    packages.push(...contribution.packages)
    types.push(...contribution.types)
    allowBuilds.push(...contribution.allowBuilds)
  }

  return Object.freeze({
    packages: Object.freeze(Object.fromEntries(
      unique(packages).map(name => [name, versionOf(versions, name)]),
    )),
    types: Object.freeze(unique(types)),
    allowBuilds: Object.freeze(unique(allowBuilds)),
  })
}

/**
 * Materializes invocations as container steps. `exec` resolves an installed binary, which a
 * container needs and a package-manager script does not.
 */
export const runSteps = (invocations, exec) => invocations.map(invocation => ({
  RUN: invocation.tool === undefined ? invocation.shell : exec(invocation.tool),
}))

/**
 * Materializes the same invocations as package-manager scripts, one per intent that runs any. The
 * intent is read off the binding path, so a command contributes a script without saying so.
 */
export const scriptsFor = (commands, script) => present(DEVELOPMENT_INTENTS.map(intent => {
  const invocations = commands[`/command/${intent}`]
  return [intent, invocations === undefined || invocations.length === 0
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
