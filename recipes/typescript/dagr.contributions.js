import { derive } from '//dagr.nodes.js'

const contributionValues = contributions => Reflect.ownKeys(contributions)
  .map(name => contributions[name])

const normalizeFor = (kind, intents) => {
  if (intents === undefined) return undefined
  if (!Array.isArray(intents) || intents.some(intent => typeof intent !== 'string' || intent === '')) {
    throw new TypeError(`${kind} contribution for must be an array of intent names`)
  }
  return Object.freeze([...new Set(intents)])
}

const normalizeSteps = rendered => (Array.isArray(rendered) ? rendered : [rendered]).flat(Infinity)

/** Generate a file in its own image. Each intent has an independently addressable node. */
export function file(path, deps, { for: intents, key = path.slice('/repo/'.length), render } = {}) {
  if (!path.startsWith('/repo/') || typeof render !== 'function')
    throw new TypeError('file needs an absolute /repo path and a renderer')
  return Object.fromEntries(normalizeFor('file', intents).map(intent => [
    `/file/${intent}/${key}`, {
      deps,
      run: (args, host) => ({
        build: {
          FROM: 'alpine:3.22',
          steps: [
            { WORKDIR: path.slice(0, path.lastIndexOf('/')) },
            ...normalizeSteps(render({ intent, host: intent === 'dev' ? host : undefined }, args)),
          ],
          IGNORE: [],
          path,
        },
      }),
    },
  ]))
}

export const copyFiles = files => Object.values(files).map(file => ({
  COPY: { from: file.image, src: file.path, dest: file.path },
}))

const INVOCATION_KINDS = Object.freeze(['tool', 'shell'])

/**
 * An invocation names what to run and nothing about where: `tool` resolves from the package's
 * installed binaries, `shell` is a literal command line. Staying free of context is what lets one
 * declaration become a container step, a package.json script, or a task in some other runner.
 */
const normalizeInvocations = rendered => {
  const invocations = (Array.isArray(rendered) ? rendered : [rendered]).flat(Infinity)
  return Object.freeze(invocations.map(invocation => {
    if (invocation === null || typeof invocation !== 'object' || Array.isArray(invocation)) {
      throw new TypeError('command run must return an invocation or an array of invocations')
    }
    const kinds = INVOCATION_KINDS.filter(kind => kind in invocation)
    if (kinds.length !== 1 || typeof invocation[kinds[0]] !== 'string' || invocation[kinds[0]] === '') {
      throw new TypeError('an invocation needs exactly one of tool or shell, naming what to run')
    }
    return Object.freeze({ [kinds[0]]: invocation[kinds[0]] })
  }))
}

/** Pure command data, independent from the build and its generated files. */
export function command(deps, options = {}) {
  if (typeof options.run !== 'function') throw new TypeError('command needs run')
  const intents = normalizeFor('command', options.for)
  if (intents === undefined) throw new TypeError('command needs for')
  const order = options.order ?? 0
  if (!Number.isFinite(order)) throw new TypeError('command order must be finite')
  return derive(deps, dependencies => Object.freeze({
    for: intents,
    order,
    invocations: normalizeInvocations(options.run(dependencies)),
  }))
}

/** Every invocation an intent runs, in contributed order. */
export const invocationsFor = (contributions, intent) => contributionValues(contributions)
  .filter(contribution => contribution.for.includes(intent))
  .sort((left, right) => left.order - right.order)
  .flatMap(contribution => contribution.invocations)

/** An ordinary build node. Intent is recipe data, never inferred by the engine. */
export function target(deps, { intent, render } = {}) {
  if (typeof render !== 'function') throw new TypeError('target needs render')
  return {
    deps,
    run: (args, host) => ({ build: render({ intent, host: intent === 'dev' ? host : undefined }, args) }),
  }
}
