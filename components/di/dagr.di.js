/**
 * @template T
 * @typedef {(...dependencies: unknown[]) => T} Factory
 */

/** @typedef {string | number | symbol} PropertyKey */

/**
 * @template {PropertyKey} [Tag=PropertyKey]
 * @typedef {Readonly<{ tag: Tag }>} TagDependency
 */

/** @typedef {PropertyKey | TagDependency} Dependency */

/** @typedef {readonly PropertyKey[] | ReadonlySet<PropertyKey>} Tags */

/**
 * A frozen recipe for producing one binding.
 *
 * @template T
 * @typedef {Readonly<{
 *   deps: readonly Dependency[],
 *   factory: Factory<T>,
 *   tags: readonly PropertyKey[]
 * }>} Definition
 */

/** @typedef {Record<PropertyKey, Definition<unknown>>} Bindings */

/** @param {PropertyKey} name */
const bindingName = name => typeof name === 'symbol' ? String(name) : JSON.stringify(name)

/** @param {PropertyKey} key */
const normalizeBindingKey = key => typeof key === 'number' ? String(key) : key

/** @param {unknown} value */
const isPropertyKey = value => (
  typeof value === 'string'
  || typeof value === 'number'
  || typeof value === 'symbol'
)

/**
 * @param {Dependency} dependency
 * @returns {dependency is TagDependency}
 */
const isTagDependency = dependency => (
  dependency !== null
  && typeof dependency === 'object'
  && !Array.isArray(dependency)
  && Object.hasOwn(dependency, 'tag')
)

/**
 * @param {unknown} dependency
 * @returns {Dependency}
 */
function normalizeDependency(dependency) {
  if (isPropertyKey(dependency)) return normalizeBindingKey(dependency)
  if (
    dependency !== null
    && typeof dependency === 'object'
    && !Array.isArray(dependency)
    && Object.hasOwn(dependency, 'tag')
    && isPropertyKey(dependency.tag)
  ) {
    return Object.freeze({ tag: dependency.tag })
  }
  throw new TypeError('Binding dependencies must be property keys or { tag } selectors')
}

/**
 * @param {unknown} tags
 * @returns {readonly PropertyKey[]}
 */
function normalizeTags(tags) {
  if (!Array.isArray(tags) && !(tags instanceof Set)) {
    throw new TypeError('Binding tags must be an array or set of property keys')
  }
  const values = [...tags]
  if (values.some(tag => !isPropertyKey(tag))) {
    throw new TypeError('Binding tags must be an array or set of property keys')
  }
  return Object.freeze([...new Set(values)])
}

/**
 * @template T
 * @param {readonly Dependency[]} deps
 * @param {Factory<T>} factory
 * @param {Tags} [tags]
 * @returns {Definition<T>}
 */
function definition(deps, factory, tags = []) {
  if (!Array.isArray(deps)) {
    throw new TypeError('Binding dependencies must be an array')
  }
  if (typeof factory !== 'function') {
    throw new TypeError('Binding factory must be a function')
  }

  return Object.freeze({
    deps: Object.freeze(deps.map(normalizeDependency)),
    factory,
    tags: normalizeTags(tags),
  })
}

/**
 * @template T
 * @param {T} value
 * @param {Tags} [tags]
 * @returns {Definition<T>}
 */
export function toValue(value, tags = []) {
  return definition([], () => value, tags)
}

/**
 * @template T
 * @param {readonly Dependency[]} deps
 * @param {Factory<T>} factory
 * @param {Tags} [tags]
 * @returns {Definition<T>}
 */
export function toFun(deps, factory, tags = []) {
  return definition(deps, factory, tags)
}

/**
 * @template T
 * @param {readonly Dependency[]} deps
 * @param {new (...dependencies: unknown[]) => T} Class
 * @param {Tags} [tags]
 * @returns {Definition<T>}
 */
export function toClass(deps, Class, tags = []) {
  if (typeof Class !== 'function') {
    throw new TypeError('Binding class must be a constructor')
  }
  return definition(deps, (...args) => new Class(...args), tags)
}

/**
 * Copies and freezes user-provided definitions at the module boundary.
 *
 * @param {Bindings} bindings
 * @returns {Map<string | symbol, Definition<unknown>>}
 */
function normalize(bindings) {
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new TypeError('Module bindings must be an object')
  }

  return new Map(
    Reflect.ownKeys(bindings).map(name => {
      const binding = bindings[name]
      if (binding === null || typeof binding !== 'object') {
        throw new TypeError(`Binding ${bindingName(name)} must be a definition`)
      }
      return [name, definition(binding.deps, binding.factory, binding.tags ?? [])]
    })
  )
}

/** An immutable dependency graph that can be transformed and compiled. */
class Module {
  /** @type {Map<string | symbol, Definition<unknown>>} */
  #bindings

  /** @param {Map<string | symbol, Definition<unknown>>} bindings */
  constructor(bindings) {
    this.#bindings = bindings
    Object.freeze(this)
  }

  /**
   * @param {PropertyKey} name
   * @returns {Definition<unknown> | undefined}
   */
  definitionOf(name) {
    return this.#bindings.get(normalizeBindingKey(name))
  }

  /** @returns {IterableIterator<string | symbol>} */
  keys() {
    return this.#bindings.keys()
  }

  /**
   * Returns a module where definitions from `other` override definitions from this module.
   *
   * @param {{
   *   keys: () => IterableIterator<PropertyKey>,
   *   definitionOf: (name: PropertyKey) => Definition<unknown> | undefined
   * }} other
   * @returns {Module}
   */
  merge(other) {
    if (
      other === null
      || typeof other !== 'object'
      || typeof other.keys !== 'function'
      || typeof other.definitionOf !== 'function'
    ) {
      throw new TypeError('Can only merge another DI module')
    }
    const merged = new Map(this.#bindings)
    for (const name of other.keys()) {
      const binding = other.definitionOf(name)
      if (binding === undefined) {
        throw new TypeError(`DI module has no definition for ${bindingName(name)}`)
      }
      merged.set(
        normalizeBindingKey(name),
        definition(binding.deps, binding.factory, binding.tags ?? []),
      )
    }
    return new Module(merged)
  }

  /**
   * Retains each root and its transitive dependencies.
   *
   * @param {readonly PropertyKey[]} roots
   * @returns {Module}
   */
  shake(roots) {
    if (!Array.isArray(roots) || roots.some(root => !isPropertyKey(root))) {
      throw new TypeError('Shake roots must be an array of property keys')
    }

    const retained = new Set()

    /** @param {PropertyKey} tag */
    const taggedNames = tag => [...this.#bindings]
      .filter(([, binding]) => binding.tags.includes(tag))
      .map(([name]) => name)

    /**
     * @param {PropertyKey} name
     * @param {PropertyKey | undefined} [requiredBy]
     */
    const visit = (name, requiredBy) => {
      name = normalizeBindingKey(name)
      const binding = this.#bindings.get(name)
      if (!binding) {
        const suffix = requiredBy === undefined
          ? ''
          : ` required by ${bindingName(requiredBy)}`
        throw new Error(`Missing binding ${bindingName(name)}${suffix}`)
      }
      if (retained.has(name)) return
      retained.add(name)
      for (const dependency of binding.deps) {
        if (isTagDependency(dependency)) {
          for (const tagged of taggedNames(dependency.tag)) visit(tagged, name)
        } else {
          visit(dependency, name)
        }
      }
    }

    for (const root of roots) visit(root)
    return new Module(new Map([...this.#bindings].filter(([name]) => retained.has(name))))
  }

  /**
   * Eagerly resolves every binding once. Values, including promises, are never awaited or unwrapped.
   *
   * @returns {Readonly<Record<PropertyKey, unknown>>}
   */
  compile() {
    const values = new Map()
    const resolving = []

    /**
     * @param {PropertyKey} name
     * @param {PropertyKey | undefined} [requiredBy]
     * @returns {unknown}
     */
    const resolve = (name, requiredBy) => {
      name = normalizeBindingKey(name)
      if (values.has(name)) return values.get(name)

      const binding = this.#bindings.get(name)
      if (!binding) {
        const suffix = requiredBy === undefined
          ? ''
          : ` required by ${bindingName(requiredBy)}`
        throw new Error(`Missing binding ${bindingName(name)}${suffix}`)
      }

      const cycleAt = resolving.indexOf(name)
      if (cycleAt !== -1) {
        const cycle = [...resolving.slice(cycleAt), name].map(String).join(' -> ')
        throw new Error(`Circular dependency: ${cycle}`)
      }

      resolving.push(name)
      try {
        const dependencies = binding.deps.map(dependency => {
          if (!isTagDependency(dependency)) return resolve(dependency, name)

          const record = {}
          for (const [taggedName, taggedBinding] of this.#bindings) {
            if (!taggedBinding.tags.includes(dependency.tag)) continue
            Object.defineProperty(record, taggedName, {
              value: resolve(taggedName, name),
              enumerable: true,
              writable: false,
              configurable: false,
            })
          }
          return Object.freeze(record)
        })
        const value = binding.factory(...dependencies)
        values.set(name, value)
        return value
      } finally {
        resolving.pop()
      }
    }

    for (const name of this.#bindings.keys()) resolve(name)

    /** @type {Record<PropertyKey, unknown>} */
    const container = Object.create(null)
    for (const [name, value] of values) {
      Object.defineProperty(container, name, {
        value,
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
 * @returns {Module}
 */
export function module(bindings) {
  return new Module(normalize(bindings))
}

export default Object.freeze({ module, toValue, toFun, toClass })
