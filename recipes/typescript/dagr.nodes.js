import Glob from 'dagr:glob'

export const value = data => ({ deps: {}, run: () => ({ value: data }) })
export const select = (...patterns) => Object.freeze(patterns)
export const derive = (deps, calculate) => define(deps, (args, host) => ({
  value: calculate(args, host),
}))

// Select names, never evaluate values. Only named exact edges reach the engine.
export const define = (inputs, run) => (keys, path) => {
  const entries = []
  const groups = []
  const singles = []
  const add = (id, ref) => {
    if (entries.some(([key]) => key === id)) throw new Error(`Duplicate dependency name ${id} on ${path}`)
    entries.push([id, ref])
  }
  for (const [name, input] of Object.entries(inputs)) {
    if (typeof input === 'string') {
      add(name, input)
      singles.push(name)
      continue
    }
    if (!Array.isArray(input)) throw new TypeError(`Invalid dependency ${name} on ${path}`)
    const selected = new Set()
    for (const pattern of input) {
      if (!pattern.includes('*')) {
        if (!keys.includes(pattern)) throw new Error(`Missing dependency ${pattern} on ${path}`)
        selected.add(pattern)
      } else {
        const matches = Glob.of(pattern.slice(1))
        for (const key of keys) if (matches(key.slice(1))) selected.add(key)
      }
    }
    const group = [...selected].map(ref => {
      const id = `${name}:${ref}`
      add(id, ref)
      return [ref, id]
    })
    groups.push([name, group])
  }
  return {
    deps: Object.fromEntries(entries),
    run: (args, host) => run(Object.fromEntries([
      ...singles.map(name => [name, args[name]]),
      ...groups.map(([name, group]) => [
        name, Object.fromEntries(group.map(([ref, id]) => [ref, args[id]])),
      ]),
    ]), host, path),
  }
}

export const compose = (...features) => {
  const graph = Object.assign({}, ...features)
  const keys = Object.keys(graph)
  return Object.fromEntries(Object.entries(graph).map(([path, declaration]) => [
    path, typeof declaration === 'function' ? declaration(keys, path) : declaration,
  ]))
}
