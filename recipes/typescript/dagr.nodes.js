export const value = data => ({ deps: {}, run: () => ({ value: data }) })
export const select = (...patterns) => Object.freeze(patterns)
export const derive = (deps, calculate) => ({
  deps,
  run: (args, host) => ({ value: calculate(args, host) }),
})
export const define = (deps, run) => ({ deps, run })

/** Prefix definitions and internal dependencies. Fully qualified references stay absolute.
 * No inspection of other graphs or evaluation of dependency values.
 */
export function scope(name, definitions) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    throw new Error('Expected a namespace name')
  const prefix = ref => ref.startsWith('//') ? ref : `/${name}${ref}`
  return Object.fromEntries(Object.entries(definitions).map(([path, declaration]) => {
    const node = typeof declaration === 'function' ? declaration(path) : declaration
    return [prefix(path), {
      deps: Object.fromEntries(Object.entries(node.deps).map(([id, dep]) => [
        id, Array.isArray(dep) ? dep.map(prefix) : prefix(dep),
      ])),
      run: node.run,
    }]
  }))
}

export function packageNodes({ location, version = '0.1.0', deps = [], metadata = {} }) {
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
