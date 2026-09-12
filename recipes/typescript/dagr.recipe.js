import rdk from 'dagr:rdk'
import { index } from '//dagr.contributions.js'

export { command, fact, factsFor, file, filesFor, target } from '//dagr.contributions.js'
export * from '//dagr.features.js'
export * from '//dagr.file-utils.js'
export * from '//dagr.package-managers.js'
export { requirement, runSteps, scriptsFor } from '//dagr.model.js'
export { rdk }

const declarationOf = ({ location, version = '0.1.0', deps = [], metadata = {} } = {}) => {
  if (!location) throw new Error('A package declaration requires a location')
  return rdk.graph({
    '/package/location': rdk.value(location),
    '/package/version': rdk.value(version),
    '/package/dependencies': rdk.value(Object.freeze([...deps])),
    '/package/metadata': rdk.value(Object.freeze({ ...metadata })),
  })
}

/**
 * Builds a callable composition from an argument initializer, a runner, and an immutable base graph.
 */
export function builder(init, run, graph = rdk.graph({})) {
  if (typeof init !== 'function') throw new TypeError('builder init must be a function')
  if (typeof run !== 'function') throw new TypeError('builder run must be a function')

  const built = (...args) => run(graph.merge(init(...args)))
  return Object.assign(built, {
    graph,
    with: feature => builder(init, run, graph.merge(feature)),
  })
}

const renderIndex = graph => graph.compile(['/dagr/index'])['/dagr/index']

/** A reusable graph composition applied to one irreducible package declaration. */
export default function recipe(features = []) {
  if (!Array.isArray(features)) throw new TypeError('recipe features must be an array')
  return builder(declarationOf, renderIndex, rdk.merge(...features, index()))
}
