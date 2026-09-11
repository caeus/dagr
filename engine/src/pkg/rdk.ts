import { of as globOf } from '#pkg/glob.js'

declare const DEPENDENCY_VALUE: unique symbol
declare const BINDING_VALUE: unique symbol

export interface Dependency<T = unknown> {
  readonly [DEPENDENCY_VALUE]?: T
}

export interface OneDependency<T = unknown> extends Dependency<T> {
  readonly path: string
  readonly selectors?: never
}

export interface ManyDependency<T = unknown> extends Dependency<Readonly<Record<string, T>>> {
  readonly selectors: readonly string[]
  readonly path?: never
}

export type AnyDependency = OneDependency | ManyDependency
export type Dependencies = Readonly<Record<string, AnyDependency>>
export type ResolvedDependencies<D extends Dependencies> = Readonly<{
  [K in keyof D]: D[K] extends Dependency<infer T> ? T : never
}>

export interface Binding<T = unknown> {
  readonly deps: Dependencies
  readonly factory: (dependencies: Readonly<Record<string, unknown>>) => T
  readonly [BINDING_VALUE]?: T
}

export type Bindings = Readonly<Record<string, Binding>>
export type BindingValue<B> = B extends Binding<infer T> ? T : never
export type GraphValues<B extends Bindings> = Readonly<{
  [K in keyof B]: BindingValue<B[K]>
}>

const DEPENDENCY = Symbol.for('caeus/dagr/rdk#Dependency')
const bindingName = (name: unknown): string => JSON.stringify(name)

function validatePath(path: unknown, role: string, allowGlob: boolean): boolean {
  if (typeof path !== 'string') {
    throw new TypeError(`${role} must be an absolute semantic path`)
  }
  if (!path.startsWith('/')) {
    throw new Error(`${role} ${bindingName(path)} must start with "/"`)
  }
  if (path === '/') throw new Error(`${role} cannot be "/"`)
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

function normalizeBindingName(name: unknown): string {
  validatePath(name, 'Binding name', false)
  return name as string
}

function dependencyKind(dependency: object): unknown {
  return (dependency as Record<PropertyKey, unknown>)[DEPENDENCY]
}

export function one<T = unknown>(path: string): OneDependency<T> {
  if (arguments.length !== 1) throw new TypeError('one accepts exactly one argument')
  validatePath(path, 'one dependency', false)
  return Object.freeze({ [DEPENDENCY]: 'one', path }) as OneDependency<T>
}

export function many<T = unknown>(...selectors: string[]): ManyDependency<T> {
  if (selectors.length === 0) throw new TypeError('many requires at least one selector')
  selectors.forEach(selector => validatePath(selector, 'many selector', true))
  return Object.freeze({
    [DEPENDENCY]: 'many',
    selectors: Object.freeze([...selectors]),
  }) as ManyDependency<T>
}

function normalizeDependency(dependency: unknown): AnyDependency {
  if (dependency === null || typeof dependency !== 'object' || Array.isArray(dependency)) {
    throw new TypeError('Binding dependency must be declared with one() or many()')
  }
  if (dependencyKind(dependency) === 'one') {
    return one((dependency as { path?: unknown }).path as string)
  }
  if (dependencyKind(dependency) === 'many') {
    return many(...((dependency as { selectors?: unknown }).selectors as string[]))
  }
  throw new TypeError('Binding dependency must be declared with one() or many()')
}

function normalizeDependencies(deps: unknown): Dependencies {
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
    throw new TypeError('Binding dependencies must be an object')
  }

  const input = deps as Record<PropertyKey, unknown>
  const normalized: Record<string, AnyDependency> = {}
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') {
      throw new TypeError('Binding dependency names must be strings')
    }
    Object.defineProperty(normalized, key, {
      value: normalizeDependency(input[key]),
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  return Object.freeze(normalized)
}

function binding<T>(
  deps: unknown,
  factory: (dependencies: Readonly<Record<string, unknown>>) => T,
): Binding<T> {
  if (typeof factory !== 'function') throw new TypeError('Binding factory must be a function')
  return Object.freeze({ deps: normalizeDependencies(deps), factory })
}

export function value<T>(input: T): Binding<T> {
  if (arguments.length !== 1) throw new TypeError('value accepts exactly one argument')
  return binding({}, () => input)
}

export function derive<const D extends Dependencies, T>(
  deps: D,
  factory: (dependencies: ResolvedDependencies<D>) => T,
): Binding<T> {
  if (arguments.length !== 2) throw new TypeError('derive accepts exactly two arguments')
  return binding(deps, factory as (dependencies: Readonly<Record<string, unknown>>) => T)
}

export function construct<const D extends Dependencies, T>(
  deps: D,
  Class: new (dependencies: ResolvedDependencies<D>) => T,
): Binding<T> {
  if (arguments.length !== 2) throw new TypeError('construct accepts exactly two arguments')
  if (typeof Class !== 'function') throw new TypeError('Binding class must be a constructor')
  return binding(
    deps,
    dependencies => new Class(dependencies as ResolvedDependencies<D>),
  )
}

function normalize(bindings: unknown): Map<string, Binding> {
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new TypeError('Graph bindings must be an object')
  }

  const input = bindings as Record<PropertyKey, unknown>
  return new Map(Reflect.ownKeys(input).map(inputName => {
    const name = normalizeBindingName(inputName)
    const candidate = input[name]
    if (candidate === null || typeof candidate !== 'object') {
      throw new TypeError(`Binding ${bindingName(name)} must be a binding`)
    }
    const bindingInput = candidate as Partial<Binding>
    return [
      name,
      binding(
        bindingInput.deps,
        bindingInput.factory as (dependencies: Readonly<Record<string, unknown>>) => unknown,
      ),
    ]
  }))
}

/** Immutable RDK dependency graph. */
export class Graph<B extends Bindings = Bindings> {
  readonly #bindings: ReadonlyMap<string, Binding>

  constructor(bindings: ReadonlyMap<string, Binding>) {
    this.#bindings = bindings
    Object.freeze(this)
  }

  bindingOf<K extends keyof B & string>(name: K): B[K] | undefined
  bindingOf(name: string): Binding | undefined
  bindingOf(name: string): Binding | undefined {
    return this.#bindings.get(normalizeBindingName(name))
  }

  keys(): IterableIterator<keyof B & string> {
    return this.#bindings.keys() as IterableIterator<keyof B & string>
  }

  merge(...others: readonly Graph[]): Graph {
    const merged = new Map(this.#bindings)
    others.forEach((other, position) => {
      if (!(other instanceof Graph)) {
        throw new TypeError(`Can only merge another graph, got ${typeof other} at ${position}`)
      }
      for (const name of other.keys()) merged.set(name, other.bindingOf(name))
    })
    return new Graph(merged)
  }

  compile(): GraphValues<B>
  compile(roots: readonly string[]): Partial<GraphValues<B>>
  compile(roots?: readonly string[]): GraphValues<B> | Partial<GraphValues<B>> {
    if (roots !== undefined && !Array.isArray(roots)) {
      throw new TypeError('Compile roots must be an array of absolute semantic paths')
    }

    const selectors = new Map<string, (path: string) => boolean>()
    const matcher = (selector: string): ((path: string) => boolean) => {
      let matches = selectors.get(selector)
      if (matches === undefined) {
        const relative = globOf(selector.slice(1))
        matches = path => relative(path.slice(1))
        selectors.set(selector, matches)
      }
      return matches
    }
    const matchingNames = (selectorGroup: readonly string[]): string[] => [...this.#bindings.keys()]
      .filter(name => selectorGroup.some(selector => matcher(selector)(name)))

    const normalizedRoots = roots === undefined
      ? [...this.#bindings.keys()]
      : roots.map(root => {
          validatePath(root, 'Compile root', true)
          return root
        })

    const values = new Map<string, unknown>()
    const resolving: string[] = []

    const resolveDependency = (dependency: AnyDependency, requiredBy: string): unknown => {
      if (dependencyKind(dependency) === 'one') return resolve(dependency.path!, requiredBy)
      const record: Record<string, unknown> = {}
      for (const matched of matchingNames(dependency.selectors!)) {
        Object.defineProperty(record, matched, {
          value: resolve(matched, requiredBy),
          enumerable: true,
          writable: false,
          configurable: false,
        })
      }
      return Object.freeze(record)
    }

    const resolve = (name: string, requiredBy?: string): unknown => {
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
        const dependencies: Record<string, unknown> = {}
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

    const container: Record<string, unknown> = Object.create(null)
    for (const name of this.#bindings.keys()) {
      if (!values.has(name)) continue
      Object.defineProperty(container, name, {
        value: values.get(name),
        enumerable: true,
        writable: false,
        configurable: false,
      })
    }
    return Object.freeze(container) as GraphValues<B> | Partial<GraphValues<B>>
  }
}

export function graph<const B extends Bindings>(bindings: B): Graph<B> {
  return new Graph<B>(normalize(bindings))
}

export function merge(...graphs: readonly Graph[]): Graph {
  return graph({}).merge(...graphs)
}
