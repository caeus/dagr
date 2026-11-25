import { derive, define } from '//dagr.nodes.js'

const contributionValues = contributions => Reflect.ownKeys(contributions)
  .map(name => contributions[name])

const normalizeFor = (kind, intents) => {
  if (intents === undefined) return undefined
  if (!Array.isArray(intents) || intents.some(intent => typeof intent !== 'string' || intent === '')) {
    throw new TypeError(`${kind} contribution for must be an array of intent names`)
  }
  return Object.freeze([...new Set(intents)])
}

const normalizeSteps = rendered => {
  const steps = (Array.isArray(rendered) ? rendered : [rendered]).flat(Infinity)
  if (steps.some(step => step === null || typeof step !== 'object' || Array.isArray(step))) {
    throw new TypeError('file contribution render must return a Dagr step or an array of steps')
  }
  return steps
}

const matches = (contribution, context) => (
  contribution.for === undefined || contribution.for.includes(context.intent)
)

const normalizeOrder = (kind, order = 0) => {
  if (typeof order !== 'number' || !Number.isFinite(order)) {
    throw new TypeError(`${kind} contribution order must be a finite number`)
  }
  return order
}

const deriveContribution = (kind, deps, factory) => {
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
    throw new TypeError(`${kind} contribution dependencies must be an object`)
  }
  return derive(deps, factory)
}

/**
 * A graph binding whose value renders one or more steps that materialize files. Files are the
 * context-aware kind: what a tsconfig or a manifest contains genuinely differs per intent.
 */
export const file = (deps, options = {}) => {
  if (typeof options.render !== 'function') throw new TypeError('file contribution needs render')
  const intents = normalizeFor('file', options.for)
  const order = normalizeOrder('file', options.order)
  return deriveContribution(
    'file',
    deps,
    dependencies => Object.freeze({
      for: intents,
      order,
      render: context => normalizeSteps(options.render(context, dependencies)),
    }),
  )
}

/** Every file contribution applying to a context, rendered in contribution order. */
export const filesFor = (contributions, context) => contributionValues(contributions)
  .filter(contribution => matches(contribution, context))
  .sort((left, right) => left.order - right.order)
  .flatMap(contribution => contribution.render(context))

const INVOCATION_KINDS = Object.freeze(['tool', 'shell'])
const EMPTY_FILES = Object.freeze({})

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

/**
 * A graph binding declaring what an intent runs. An input named `files` is an ordinary dependency
 * with one extra meaning: an exact-path `many()` naming the canonical files that invocation needs, so
 * a target selecting the capability materializes it as a unit.
 */
export const command = (deps, options = {}) => {
  if (typeof options.run !== 'function') throw new TypeError('command contribution needs run')
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
    throw new TypeError('command contribution dependencies must be an object')
  }
  if (deps.files !== undefined && (
    !Array.isArray(deps.files)
    || deps.files.some(path => typeof path !== 'string' || path.includes('*'))
  )) {
    throw new TypeError('command contribution files must use select() with exact semantic paths')
  }
  const intents = normalizeFor('command', options.for)
  if (intents === undefined) {
    throw new TypeError('command contribution needs for, the intents whose run it is')
  }
  const order = normalizeOrder('command', options.order)
  return deriveContribution(
    'command',
    deps,
    dependencies => Object.freeze({
      for: intents,
      order,
      files: dependencies.files ?? EMPTY_FILES,
      invocations: normalizeInvocations(options.run(dependencies)),
    }),
  )
}

/** Every invocation an intent runs, in contributed order. */
export const invocationsFor = (contributions, intent) => contributionValues(contributions)
  .filter(contribution => contribution.for.includes(intent))
  .sort((left, right) => left.order - right.order)
  .flatMap(contribution => contribution.invocations)

export const contextFor = context => {
  const base = Object.freeze({
    intent: context.intent,
    facet: context.facet,
    host: context.host,
  })

  const withContext = overrides => Object.freeze({
    ...base,
    ...(overrides ?? {}),
  })

  return Object.freeze({
    ...base,
    files: (files, overrides) => filesFor(files, withContext(overrides)),
  })
}

/** A build declaration. Intent is a recipe convention, not an engine concept. */
export function target(deps, { intent, render } = {}) {
  if (typeof render !== 'function') throw new TypeError('target needs render')
  return define(deps, (args, host, path) => {
    const segments = path.split('/')
    return { build: render(contextFor({
      intent: intent ?? segments.at(-1), facet: segments.at(-2), host,
    }), args) }
  })
}

export default Object.freeze({ file, filesFor, command, target })
