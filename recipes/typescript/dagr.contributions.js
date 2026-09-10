import rdk from '//rdk//dagr.rdk.js'

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

/**
 * A graph binding whose value renders one or more steps that materialize files. Files are the
 * context-aware kind: what a tsconfig or a manifest contains genuinely differs per intent.
 */
export const file = (deps, options = {}) => {
  if (!Array.isArray(deps)) throw new TypeError('file contribution dependencies must be an array')
  if (typeof options.render !== 'function') throw new TypeError('file contribution needs render')
  const intents = normalizeFor('file', options.for)
  const order = normalizeOrder('file', options.order)
  return rdk.derive(
    deps,
    (...values) => Object.freeze({
      for: intents,
      order,
      render: context => normalizeSteps(options.render(context, ...values)),
    }),
  )
}

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

/** A graph binding declaring what an intent runs, for any renderer to materialize. */
export const command = (deps, options = {}) => {
  if (!Array.isArray(deps)) throw new TypeError('command contribution dependencies must be an array')
  if (typeof options.run !== 'function') throw new TypeError('command contribution needs run')
  const intents = normalizeFor('command', options.for)
  if (intents === undefined) {
    throw new TypeError('command contribution needs for, the intents whose run it is')
  }
  const order = normalizeOrder('command', options.order)
  return rdk.derive(
    deps,
    (...values) => Object.freeze({
      for: intents,
      order,
      invocations: normalizeInvocations(options.run(...values)),
    }),
  )
}

/** Every invocation an intent runs, in contributed order. */
export const invocationsFor = (contributions, intent) => contributionValues(contributions)
  .filter(contribution => contribution.for.includes(intent))
  .sort((left, right) => left.order - right.order)
  .flatMap(contribution => contribution.invocations)

export const contextFor = (context, files, commands) => {
  const base = Object.freeze({
    intent: context.intent,
    facet: context.facet,
    host: context.host,
  })

  const withContext = overrides => Object.freeze({
    ...base,
    ...(overrides ?? {}),
  })

  const render = (item, overrides) => {
    const current = withContext(overrides)
    return matches(item, current) ? item.render(current) : []
  }

  const renderAll = (items, overrides) => contributionValues(items)
    .sort((left, right) => left.order - right.order)
    .flatMap(item => render(item, overrides))

  return Object.freeze({
    ...base,
    files: overrides => renderAll(files, overrides),
    invocations: overrides => invocationsFor(commands, withContext(overrides).intent),
  })
}

/**
 * A target binding. File and command collections are selected automatically; ordinary graph
 * dependencies keep their normal positions before the context. Its `/target/<facet>/<name>` path
 * supplies the Dagr facet and target name when the index materializes it.
 */
export function target(deps, {
  intent,
  render,
} = {}) {
  if (!Array.isArray(deps)) throw new TypeError('target contribution dependencies must be an array')
  if (intent !== undefined && (typeof intent !== 'string' || intent === '')) {
    throw new Error('target contribution intent must be a non-empty string')
  }
  if (typeof render !== 'function') throw new Error('target contribution needs render')

  return rdk.derive(
    [...deps, '/file/**', '/command/**'],
    (...values) => {
      const commands = values.pop()
      const files = values.pop()
      return Object.freeze({
        materialize(name, facet) {
          const context = contextFor({ intent: intent ?? name, facet, host: undefined }, files, commands)
          const rendered = render(context, ...values)
          if (rendered === null || typeof rendered !== 'object' || Array.isArray(rendered)) {
            throw new TypeError(`target ${JSON.stringify(`${facet}:${name}`)} render must return a Dagr target`)
          }
          if (!Array.isArray(rendered.deps)) {
            throw new TypeError(`target ${JSON.stringify(`${facet}:${name}`)} needs deps`)
          }
          if (typeof rendered.run !== 'function') {
            throw new TypeError(`target ${JSON.stringify(`${facet}:${name}`)} needs run`)
          }
          return Object.freeze({
            name,
            deps: Object.freeze([...rendered.deps]),
            run: rendered.run,
          })
        },
      })
    },
  )
}

const targetCoordinates = path => {
  const [, kind, facet, name, ...rest] = path.split('/')
  if (kind !== 'target' || !facet || !name || rest.length !== 0) {
    throw new Error(`Target binding ${JSON.stringify(path)} must have the form "/target/<facet>/<name>"`)
  }
  return { facet, name }
}

/**
 * Dagr resolves a bare `target` against the depending target's own facet and a `facet:target` pair
 * against its package, so both name a sibling this index must own. A `package:facet:target` triple
 * names someone else's target and cannot be checked here.
 */
const localRef = (dependency, facet) => {
  if (typeof dependency !== 'string' || dependency.includes('/')) return undefined
  const parts = dependency.split(':')
  if (parts.length === 1) return [facet, parts[0]]
  if (parts.length === 2) return parts
  return undefined
}

const validateLocalRefs = facets => {
  for (const [facet, targets] of Object.entries(facets)) {
    for (const [name, target] of Object.entries(targets)) {
      for (const dependency of target.deps) {
        const sibling = localRef(dependency, facet)
        if (sibling === undefined) continue
        if (facets[sibling[0]]?.[sibling[1]] === undefined) {
          throw new Error(
            `target ${JSON.stringify(`${facet}:${name}`)} depends on ${JSON.stringify(dependency)}, which no contribution owns`,
          )
        }
      }
    }
  }
}

/** The deliberately boring final calculation: materialize target paths, group, and validate refs. */
export const index = () => rdk.graph({
  '/dagr/index': rdk.derive(['/target/**'], bindings => {
    const facets = {}
    for (const path of Object.keys(bindings)) {
      const { facet, name } = targetCoordinates(path)
      const targets = facets[facet] ??= {}
      targets[name] = bindings[path].materialize(name, facet)
    }
    validateLocalRefs(facets)
    return facets
  }),
})

export default Object.freeze({ file, command, target })
