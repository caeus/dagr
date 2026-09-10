import { of as globOf } from 'dagr:glob'

/**
 * @template T
 * @typedef {(...dependencies: unknown[]) => T} Factory
 */

/** @typedef {string} Dependency */

/**
 * A frozen recipe for producing one binding value.
 *
 * @template T
 * @typedef {Readonly<{
 *   deps: readonly Dependency[],
 *   factory: Factory<T>,
 * }>} Binding
 */

/** @typedef {Record<string, Binding<unknown>>} Bindings */

/** @param {unknown} name */
const bindingName = name => JSON.stringify(name)

/**
 * Validates an absolute semantic path and returns whether it is a glob selector.
 *
 * `dagr:glob` owns matching and wildcard grammar. RDK owns the absolute-path rules shared by
 * binding names, dependencies, and compile roots.
 *
 * @param {unknown} path
 * @param {string} role
 * @param {boolean} allowGlob
 * @returns {boolean}
 */
function validatePath(path, role, allowGlob) {
  if (typeof path !== 'string') {
    throw new TypeError(`${role} must be an absolute semantic path`)
  }
  if (!path.startsWith('/')) {
    throw new Error(`${role} ${bindingName(path)} must start with "/"`)
  }
  if (path === '/') {
    throw new Error(`${role} cannot be "/"`)
  }
  if (path.endsWith('/')) {
    throw new Error(`${role} ${bindingName(path)} must not end with "/"`)
  }

  const segments = path.slice(1).split('/')
  if (segments.includes('')) {
    throw new Error(`${role} ${bindingName(path)} must not contain "//"`)
  }
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error(`${role} ${bindingName(path)} must not contain "." or ".." segments`)
  }

  const wildcard = segments.some(segment => segment.includes('*'))
  if (wildcard && !allowGlob) {
    throw new Error(`${role} ${bindingName(path)} must not contain reserved wildcards "*" or "**"`)
  }
  if (wildcard) globOf(path.slice(1))
  return wildcard
}

/** @param {unknown} name */
function normalizeBindingName(name) {
  validatePath(name, 'Binding name', false)
  return name
}

/** @param {unknown} dependency */
function normalizeDependency(dependency) {
  validatePath(dependency, 'Binding dependency', true)
  return dependency
}

/**
 * @template T
 * @param {readonly Dependency[]} deps
 * @param {Factory<T>} factory
 * @returns {Binding<T>}
 */
function binding(deps, factory) {
  if (!Array.isArray(deps)) {
    throw new TypeError('Binding dependencies must be an array')
  }
  if (typeof factory !== 'function') {
    throw new TypeError('Binding factory must be a function')
  }

  return Object.freeze({
    deps: Object.freeze(deps.map(normalizeDependency)),
    factory,
  })
}

/**
 * @template T
 * @param {T} input
 * @returns {Binding<T>}
 */
export function value(input) {
  if (arguments.length !== 1) throw new TypeError('value accepts exactly one argument')
  return binding([], () => input)
}

/**
 * @template T
 * @param {readonly Dependency[]} deps
 * @param {Factory<T>} factory
 * @returns {Binding<T>}
 */
export function derive(deps, factory) {
  if (arguments.length !== 2) throw new TypeError('derive accepts exactly two arguments')
  return binding(deps, factory)
}

/**
 * @template T
 * @param {readonly Dependency[]} deps
 * @param {new (...dependencies: unknown[]) => T} Class
 * @returns {Binding<T>}
 */
export function construct(deps, Class) {
  if (arguments.length !== 2) throw new TypeError('construct accepts exactly two arguments')
  if (typeof Class !== 'function') {
    throw new TypeError('Binding class must be a constructor')
  }
  return binding(deps, (...args) => new Class(...args))
}

/**
 * Copies and freezes user-provided bindings at the graph boundary.
 *
 * @param {Bindings} bindings
 * @returns {Map<string, Binding<unknown>>}
 */
function normalize(bindings) {
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new TypeError('Graph bindings must be an object')
  }

  return new Map(
    Reflect.ownKeys(bindings).map(inputName => {
      const name = normalizeBindingName(inputName)
      const input = bindings[name]
      if (input === null || typeof input !== 'object') {
        throw new TypeError(`Binding ${bindingName(name)} must be a binding`)
      }
      return [name, binding(input.deps, input.factory)]
    }),
  )
}

/**
 * Recipes are loaded as separate module instances, so each one defines its own `Graph` class and
 * class identity cannot be compared. A registry symbol is shared by every instance in the isolate.
 */
const GRAPH = Symbol.for('caeus/dagr/rdk#Graph')

/** An immutable dependency graph backed by a flat map of semantic paths. */
class Graph {
  /**
   * @param {unknown} other
   * @returns {other is Graph}
   */
  static [Symbol.hasInstance](other) {
    return other !== null && typeof other === 'object' && other[GRAPH] === true
  }

  /** @type {Map<string, Binding<unknown>>} */
  #bindings

  /** @param {Map<string, Binding<unknown>>} bindings */
  constructor(bindings) {
    this.#bindings = bindings
    Object.freeze(this)
  }

  get [GRAPH]() {
    return true
  }

  /**
   * @param {string} name
   * @returns {Binding<unknown> | undefined}
   */
  bindingOf(name) {
    return this.#bindings.get(normalizeBindingName(name))
  }

  /** @returns {IterableIterator<string>} */
  keys() {
    return this.#bindings.keys()
  }

  /**
   * Returns a graph where later bindings replace earlier ones, this graph being the earliest.
   * Replacement preserves the binding's existing position; new paths append in merge order.
   *
   * @param {...Graph} others
   * @returns {Graph}
   */
  merge(...others) {
    const merged = new Map(this.#bindings)
    others.forEach((other, position) => {
      if (!(other instanceof Graph)) {
        throw new TypeError(`Can only merge another graph, got ${typeof other} at ${position}`)
      }
      for (const name of other.keys()) merged.set(name, other.bindingOf(name))
    })
    return new Graph(merged)
  }

  /**
   * Eagerly resolves every reachable binding once. When roots are omitted, every binding is
   * resolved. Exact roots begin at one binding; glob roots begin at every match. Dependencies are
   * discovered and resolved while traversing from those roots.
   *
   * @param {readonly string[]} [roots]
   * @returns {Readonly<Record<string, unknown>>}
   */
  compile(roots) {
    if (roots !== undefined && !Array.isArray(roots)) {
      throw new TypeError('Compile roots must be an array of absolute semantic paths')
    }

    /** @type {Map<string, (path: string) => boolean>} */
    const selectors = new Map()
    /** @param {string} selector */
    const matcher = selector => {
      let matches = selectors.get(selector)
      if (matches === undefined) {
        const relative = globOf(selector.slice(1))
        matches = path => relative(path.slice(1))
        selectors.set(selector, matches)
      }
      return matches
    }
    /** @param {string} selector */
    const matchingNames = selector => [...this.#bindings.keys()].filter(matcher(selector))

    /** @type {string[]} */
    const normalizedRoots = roots === undefined
      ? [...this.#bindings.keys()]
      : roots.map(root => {
          validatePath(root, 'Compile root', true)
          return root
        })

    const values = new Map()
    const resolving = []

    /**
     * @param {string} name
     * @param {string | undefined} [requiredBy]
     * @returns {unknown}
     */
    const resolve = (name, requiredBy) => {
      if (values.has(name)) return values.get(name)

      const current = this.#bindings.get(name)
      if (!current) {
        const suffix = requiredBy === undefined ? '' : ` required by ${bindingName(requiredBy)}`
        throw new Error(`Missing binding ${bindingName(name)}${suffix}`)
      }

      const cycleAt = resolving.indexOf(name)
      if (cycleAt !== -1) {
        const cycle = [...resolving.slice(cycleAt), name].join(' -> ')
        throw new Error(`Circular dependency: ${cycle}`)
      }

      resolving.push(name)
      try {
        const dependencies = current.deps.map(dependency => {
          if (!dependency.includes('*')) return resolve(dependency, name)

          const record = {}
          for (const matched of matchingNames(dependency)) {
            Object.defineProperty(record, matched, {
              value: resolve(matched, name),
              enumerable: true,
              writable: false,
              configurable: false,
            })
          }
          return Object.freeze(record)
        })
        const result = current.factory(...dependencies)
        values.set(name, result)
        return result
      } finally {
        resolving.pop()
      }
    }

    for (const root of normalizedRoots) {
      if (root.includes('*')) {
        for (const matched of matchingNames(root)) resolve(matched)
      } else {
        resolve(root)
      }
    }

    /** @type {Record<string, unknown>} */
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

/**
 * @param {Bindings} bindings
 * @returns {Graph}
 */
export function graph(bindings) {
  return new Graph(normalize(bindings))
}

/**
 * Merges graphs into one, later bindings replacing earlier ones. No graphs produce an empty one.
 *
 * @param {...Graph} graphs
 * @returns {Graph}
 */
export function merge(...graphs) {
  return graph({}).merge(...graphs)
}

export default Object.freeze({ graph, merge, value, derive, construct })
