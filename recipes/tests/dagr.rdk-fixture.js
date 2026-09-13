import { of as globOf } from 'dagr:glob'

/**
 * @template T
 * @typedef {(resolved: Readonly<{
 *   keys: Readonly<Record<string, unknown>>,
 *   patterns: Readonly<Record<string, unknown>>,
 * }>) => T} Project
 */

/**
 * @template T
 * @typedef {(inputs: Readonly<Record<string, unknown>>) => T} Factory
 */

const INPUT = Symbol.for('caeus/dagr/rdk#Input')

/**
 * @template T
 * @typedef {Readonly<{
 *   [INPUT]: 'input',
 *   keys: readonly string[],
 *   patterns: readonly string[],
 *   project: Project<T>,
 *   path?: string,
 *   selectors?: readonly string[],
 * }>} Input
 */

/** @typedef {Readonly<Record<string, Input<unknown>>>} Inputs */

/**
 * A frozen recipe for producing one binding value.
 *
 * @template T
 * @typedef {Readonly<{
 *   inputs: Inputs,
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
 * binding names, inputs, and compile roots.
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

/**
 * @template T
 * @param {unknown} dependencies
 * @param {unknown} project
 * @returns {Input<T>}
 */
function inputDeclaration(dependencies, project) {
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new TypeError('input dependencies must be an object')
  }
  if (typeof project !== 'function') throw new TypeError('input projection must be a function')

  const keys = dependencies.keys ?? []
  const patterns = dependencies.patterns ?? []
  if (!Array.isArray(keys)) throw new TypeError('input keys must be an array')
  if (!Array.isArray(patterns)) throw new TypeError('input patterns must be an array')

  keys.forEach(path => validatePath(path, 'input key', false))
  patterns.forEach(pattern => validatePath(pattern, 'input pattern', true))
  return Object.freeze({
    [INPUT]: 'input',
    keys: Object.freeze([...keys]),
    patterns: Object.freeze([...patterns]),
    project,
  })
}

/**
 * Declares required exact keys and optional plural patterns, then projects their resolved values.
 *
 * @template T
 * @param {{ keys?: readonly string[], patterns?: readonly string[] }} dependencies
 * @param {Project<T>} project
 * @returns {Input<T>}
 */
export function input(dependencies, project) {
  if (arguments.length !== 2) throw new TypeError('input accepts exactly two arguments')
  return inputDeclaration(dependencies, project)
}

/**
 * Declares one required exact input.
 *
 * @param {string} path
 * @returns {Input<unknown>}
 */
export function one(path) {
  if (arguments.length !== 1) throw new TypeError('one accepts exactly one argument')
  validatePath(path, 'one input', false)
  return Object.freeze({
    ...input({ keys: [path] }, ({ keys }) => keys[path]),
    path,
  })
}

/**
 * Declares an input containing every binding matching any selector.
 *
 * @param {...string} selectors
 * @returns {Input<Readonly<Record<string, unknown>>>}
 */
export function many(...selectors) {
  if (selectors.length === 0) throw new TypeError('many requires at least one selector')
  selectors.forEach(selector => validatePath(selector, 'many selector', true))
  return Object.freeze({
    ...input({ patterns: selectors }, ({ patterns }) => patterns),
    selectors: Object.freeze([...selectors]),
  })
}

/** @param {unknown} candidate */
function normalizeInput(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('Binding input must be declared with input(), one() or many()')
  }
  if (candidate[INPUT] !== 'input') {
    throw new TypeError('Binding input must be declared with input(), one() or many()')
  }

  const normalized = inputDeclaration(
    { keys: candidate.keys, patterns: candidate.patterns },
    candidate.project,
  )
  if (candidate.path !== undefined && candidate.selectors !== undefined) {
    throw new TypeError('Binding input cannot be both one() and many()')
  }
  if (candidate.path !== undefined) {
    validatePath(candidate.path, 'one input', false)
    return Object.freeze({ ...normalized, path: candidate.path })
  }
  if (candidate.selectors !== undefined) {
    if (!Array.isArray(candidate.selectors)) {
      throw new TypeError('Binding input must be declared with input(), one() or many()')
    }
    candidate.selectors.forEach(selector => validatePath(selector, 'many selector', true))
    return Object.freeze({
      ...normalized,
      selectors: Object.freeze([...candidate.selectors]),
    })
  }
  return normalized
}

/** @param {unknown} inputs */
function normalizeInputs(inputs) {
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new TypeError('Binding inputs must be an object')
  }

  const normalized = {}
  for (const key of Reflect.ownKeys(inputs)) {
    if (typeof key !== 'string') {
      throw new TypeError('Binding input names must be strings')
    }
    Object.defineProperty(normalized, key, {
      value: normalizeInput(inputs[key]),
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  return Object.freeze(normalized)
}

/**
 * @template T
 * @param {unknown} inputs
 * @param {Factory<T>} factory
 * @returns {Binding<T>}
 */
function binding(inputs, factory) {
  if (typeof factory !== 'function') {
    throw new TypeError('Binding factory must be a function')
  }
  return Object.freeze({ inputs: normalizeInputs(inputs), factory })
}

/**
 * @template T
 * @param {T} valueInput
 * @returns {Binding<T>}
 */
export function value(valueInput) {
  if (arguments.length !== 1) throw new TypeError('value accepts exactly one argument')
  return binding({}, () => valueInput)
}

/**
 * @template T
 * @param {Record<string, Input<unknown>>} inputs
 * @param {Factory<T>} factory
 * @returns {Binding<T>}
 */
export function derive(inputs, factory) {
  if (arguments.length !== 2) throw new TypeError('derive accepts exactly two arguments')
  return binding(inputs, factory)
}

/**
 * @template T
 * @param {Record<string, Input<unknown>>} inputs
 * @param {new (inputs: Readonly<Record<string, unknown>>) => T} Class
 * @returns {Binding<T>}
 */
export function construct(inputs, Class) {
  if (arguments.length !== 2) throw new TypeError('construct accepts exactly two arguments')
  if (typeof Class !== 'function') {
    throw new TypeError('Binding class must be a constructor')
  }
  return binding(inputs, resolved => new Class(resolved))
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
      const candidate = bindings[name]
      if (candidate === null || typeof candidate !== 'object') {
        throw new TypeError(`Binding ${bindingName(name)} must be a binding`)
      }
      return [name, binding(candidate.inputs, candidate.factory)]
    }),
  )
}

/** @param {Iterable<readonly [string, unknown]>} entries */
function immutableRecord(entries) {
  const record = {}
  for (const [name, value] of entries) {
    Object.defineProperty(record, name, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  return Object.freeze(record)
}

/**
 * Recipes are loaded as separate module instances, so each one defines its own `Graph` class and
 * class identity cannot be compared. A registry symbol is shared by every instance in the isolate.
 */
const GRAPH = Symbol.for('caeus/dagr/rdk#Graph')

/** An immutable graph backed by a flat map of semantic paths. */
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
   * resolved. Exact roots begin at one binding; glob roots begin at every match. Inputs are
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
    const matchers = new Map()
    /** @param {string} pattern */
    const matcher = pattern => {
      let matches = matchers.get(pattern)
      if (matches === undefined) {
        const relative = globOf(pattern.slice(1))
        matches = path => relative(path.slice(1))
        matchers.set(pattern, matches)
      }
      return matches
    }

    /** @param {readonly string[]} patterns */
    const matchingNames = patterns => {
      const found = new Set()
      for (const pattern of patterns) {
        if (!pattern.includes('*')) {
          if (this.#bindings.has(pattern)) found.add(pattern)
          continue
        }
        const matches = matcher(pattern)
        for (const name of this.#bindings.keys()) {
          if (matches(name)) found.add(name)
        }
      }
      return [...this.#bindings.keys()].filter(name => found.has(name))
    }

    /** @type {string[]} */
    const normalizedRoots = roots === undefined
      ? [...this.#bindings.keys()]
      : roots.map(root => {
          validatePath(root, 'Compile root', true)
          return root
        })

    const values = new Map()
    const resolving = []
    /** @type {(name: string, requiredBy?: string) => unknown} */
    let resolve

    /** @param {Input<unknown>} declared @param {string} requiredBy */
    const resolveInput = (declared, requiredBy) => {
      const keys = immutableRecord(
        declared.keys.map(path => [path, resolve(path, requiredBy)]),
      )
      const patterns = immutableRecord(
        matchingNames(declared.patterns).map(path => [path, resolve(path, requiredBy)]),
      )
      return declared.project(Object.freeze({ keys, patterns }))
    }

    resolve = (name, requiredBy) => {
      if (values.has(name)) return values.get(name)

      const current = this.#bindings.get(name)
      if (!current) {
        const suffix = requiredBy === undefined ? '' : ` required by ${bindingName(requiredBy)}`
        throw new Error(`Missing binding ${bindingName(name)}${suffix}`)
      }

      const cycleAt = resolving.indexOf(name)
      if (cycleAt !== -1) {
        const cycle = [...resolving.slice(cycleAt), name].join(' -> ')
        throw new Error(`Circular input: ${cycle}`)
      }

      resolving.push(name)
      try {
        const inputs = {}
        for (const [key, declared] of Object.entries(current.inputs)) {
          Object.defineProperty(inputs, key, {
            value: resolveInput(declared, name),
            enumerable: true,
            writable: false,
            configurable: false,
          })
        }
        const result = current.factory(Object.freeze(inputs))
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

export default Object.freeze({ graph, merge, value, input, one, many, derive, construct })
