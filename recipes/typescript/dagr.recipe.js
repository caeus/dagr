import { value, compose } from '//dagr.nodes.js'

export { value, derive, select, compose } from '//dagr.nodes.js'
export { command, file, target } from '//dagr.contributions.js'
export * from '//dagr.features.js'
export * from '//dagr.file-utils.js'
export * from '//dagr.package-managers.js'
export {
  adapter, buildsFor, packageJsonDependencies, packageManagerBuilds,
  packagesFor, runSteps, scriptsFor, tooling, tsconfigTypes, typesFor,
} from '//dagr.model.js'

const declarationOf = ({ location, version = '0.1.0', deps = [], metadata = {} } = {}) => {
  if (!location) throw new Error('A package declaration requires a location')
  return {
    '/package/location': value(location),
    '/package/version': value(version),
    '/package/dependencies': value(Object.freeze([...deps])),
    '/package/metadata': value(Object.freeze({ ...metadata })),
    '/package/local-images': {
      deps: Object.fromEntries(deps.filter(dep => 'target' in dep).map(dep => [dep.target, dep.target])),
      run: args => ({ value: args }),
    },
  }
}

/** Compose definitions, then return the graph that Dagr evaluates. */
export default function recipe(features = []) {
  if (!Array.isArray(features)) throw new TypeError('recipe features must be an array')
  const built = declaration => compose(...features, declarationOf(declaration))
  return Object.assign(built, { with: feature => recipe([...features, feature]) })
}
