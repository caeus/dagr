export const RDK_SOURCE = String.raw`
import { of as globOf } from 'dagr:glob'

const DEPENDENCY = Symbol.for('caeus/dagr/rdk#Dependency')
const GRAPH = Symbol.for('caeus/dagr/rdk#Graph')
const bindingName = name => JSON.stringify(name)

function validatePath(path, role, allowGlob) {
  if (typeof path !== 'string') {
    throw new TypeError(role + ' must be an absolute semantic path')
  }
  if (!path.startsWith('/')) {
    throw new Error(role + ' ' + bindingName(path) + ' must start with "/"')
  }
  if (path === '/') throw new Error(role + ' cannot be "/"')
  if (path.endsWith('/')) {
    throw new Error(role + ' ' + bindingName(path) + ' must not end with "/"')
  }

  const segments = path.slice(1).split('/')
  if (segments.includes('')) {
    throw new Error(role + ' ' + bindingName(path) + ' must not contain "//"')
  }
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error(role + ' ' + bindingName(path) + ' must not contain "." or ".." segments')
  }

  const wildcard = segments.some(segment => segment.includes('*'))
  if (wildcard && !allowGlob) {
    throw new Error(role + ' ' + bindingName(path) + ' must not contain reserved wildcards "*" or "**"')
  }
  if (wildcard) globOf(path.slice(1))
  return wildcard
}

function normalizeBindingName(name) {
  validatePath(name, 'Binding name', false)
  return name
}

export function one(path) {
  if (arguments.length !== 1) throw new TypeError('one accepts exactly one argument')
  validatePath(path, 'one dependency', false)
  return Object.freeze({ [DEPENDENCY]: 'one', path })
}

export function many(...selectors) {
  if (selectors.length === 0) throw new TypeError('many requires at least one selector')
  selectors.forEach(selector => validatePath(selector, 'many selector', true))
  return Object.freeze({
    [DEPENDENCY]: 'many',
    selectors: Object.freeze([...selectors]),
  })
}

function normalizeDependency(dependency) {
  if (dependency === null || typeof dependency !== 'object' || Array.isArray(dependency)) {
    throw new TypeError('Binding dependency must be declared with one() or many()')
  }
  if (dependency[DEPENDENCY] === 'one') return one(dependency.path)
  if (dependency[DEPENDENCY] === 'many') return many(...dependency.selectors)
  throw new TypeError('Binding dependency must be declared with one() or many()')
}

function normalizeDependencies(deps) {
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
    throw new TypeError('Binding dependencies must be an object')
  }

  const normalized = {}
  for (const key of Reflect.ownKeys(deps)) {
    if (typeof key !== 'string') {
      throw new TypeError('Binding dependency names must be strings')
    }
    Object.defineProperty(normalized, key, {
      value: normalizeDependency(deps[key]),
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  return Object.freeze(normalized)
}

function binding(deps, factory) {
  if (typeof factory !== 'function') throw new TypeError('Binding factory must be a function')
  return Object.freeze({ deps: normalizeDependencies(deps), factory })
}

export function value(input) {
  if (arguments.length !== 1) throw new TypeError('value accepts exactly one argument')
  return binding({}, () => input)
}

export function derive(deps, factory) {
  if (arguments.length !== 2) throw new TypeError('derive accepts exactly two arguments')
  return binding(deps, factory)
}

export function construct(deps, Class) {
  if (arguments.length !== 2) throw new TypeError('construct accepts exactly two arguments')
  if (typeof Class !== 'function') throw new TypeError('Binding class must be a constructor')
  return binding(deps, dependencies => new Class(dependencies))
}

function normalize(bindings) {
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new TypeError('Graph bindings must be an object')
  }

  return new Map(Reflect.ownKeys(bindings).map(inputName => {
    const name = normalizeBindingName(inputName)
    const input = bindings[name]
    if (input === null || typeof input !== 'object') {
      throw new TypeError('Binding ' + bindingName(name) + ' must be a binding')
    }
    return [name, binding(input.deps, input.factory)]
  }))
}

class Graph {
  static [Symbol.hasInstance](other) {
    return other !== null && typeof other === 'object' && other[GRAPH] === true
  }

  #bindings

  constructor(bindings) {
    this.#bindings = bindings
    Object.freeze(this)
  }

  get [GRAPH]() {
    return true
  }

  bindingOf(name) {
    return this.#bindings.get(normalizeBindingName(name))
  }

  keys() {
    return this.#bindings.keys()
  }

  merge(...others) {
    const merged = new Map(this.#bindings)
    others.forEach((other, position) => {
      if (!(other instanceof Graph)) {
        throw new TypeError('Can only merge another graph, got ' + typeof other + ' at ' + position)
      }
      for (const name of other.keys()) merged.set(name, other.bindingOf(name))
    })
    return new Graph(merged)
  }

  compile(roots) {
    if (roots !== undefined && !Array.isArray(roots)) {
      throw new TypeError('Compile roots must be an array of absolute semantic paths')
    }

    const selectors = new Map()
    const matcher = selector => {
      let matches = selectors.get(selector)
      if (matches === undefined) {
        const relative = globOf(selector.slice(1))
        matches = path => relative(path.slice(1))
        selectors.set(selector, matches)
      }
      return matches
    }
    const matchingNames = selectorGroup => [...this.#bindings.keys()]
      .filter(name => selectorGroup.some(selector => matcher(selector)(name)))

    const normalizedRoots = roots === undefined
      ? [...this.#bindings.keys()]
      : roots.map(root => {
          validatePath(root, 'Compile root', true)
          return root
        })

    const values = new Map()
    const resolving = []
    let resolve

    const resolveDependency = (dependency, requiredBy) => {
      if (dependency[DEPENDENCY] === 'one') return resolve(dependency.path, requiredBy)
      const record = {}
      for (const matched of matchingNames(dependency.selectors)) {
        Object.defineProperty(record, matched, {
          value: resolve(matched, requiredBy),
          enumerable: true,
          writable: false,
          configurable: false,
        })
      }
      return Object.freeze(record)
    }

    resolve = (name, requiredBy) => {
      if (values.has(name)) return values.get(name)

      const current = this.#bindings.get(name)
      if (!current) {
        const suffix = requiredBy === undefined ? '' : ' required by ' + bindingName(requiredBy)
        throw new Error('Missing binding ' + bindingName(name) + suffix)
      }

      const cycleAt = resolving.indexOf(name)
      if (cycleAt !== -1) {
        const cycle = [...resolving.slice(cycleAt), name].join(' -> ')
        throw new Error('Circular dependency: ' + cycle)
      }

      resolving.push(name)
      try {
        const dependencies = {}
        for (const [key, dependency] of Object.entries(current.deps)) {
          Object.defineProperty(dependencies, key, {
            value: resolveDependency(dependency, name),
            enumerable: true,
            writable: false,
            configurable: false,
          })
        }
        const result = current.factory(Object.freeze(dependencies))
        values.set(name, result)
        return result
      } finally {
        resolving.pop()
      }
    }

    for (const root of normalizedRoots) {
      if (root.includes('*')) {
        for (const matched of matchingNames([root])) resolve(matched)
      } else {
        resolve(root)
      }
    }

    const container = Object.create(null)
    for (const name of this.#bindings.keys()) {
      if (!values.has(name)) continue
      Object.defineProperty(container, name, {
        value: values.get(name),
        enumerable: true,
        writable: false,
        configurable: false,
      })
    }
    return Object.freeze(container)
  }
}

export function graph(bindings) {
  return new Graph(normalize(bindings))
}

export function merge(...graphs) {
  return graph({}).merge(...graphs)
}

export default Object.freeze({ graph, merge, value, one, many, derive, construct })
`
