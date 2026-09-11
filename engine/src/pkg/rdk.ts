import { of as globOf } from '#pkg/glob.js'

declare const DEPENDENCY_VALUE: unique symbol
declare const BINDING_VALUE: unique symbol
declare const SEMANTIC_PATH_VALUE: unique symbol
declare const SELECTOR_VALUE: unique symbol

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

type SemanticPath = string & { readonly [SEMANTIC_PATH_VALUE]: true }
type Selector = string & { readonly [SELECTOR_VALUE]: true }

const DEPENDENCY = Symbol.for('caeus/dagr/rdk#Dependency')

type ExactDependency = Readonly<OneDependency & {
  readonly [DEPENDENCY]: 'one'
  readonly path: SemanticPath
}>

type CollectionDependency = Readonly<ManyDependency & {
  readonly [DEPENDENCY]: 'many'
  readonly selectors: readonly Selector[]
}>

type NormalizedDependency = ExactDependency | CollectionDependency
type NormalizedDependencies = Readonly<Record<string, NormalizedDependency>>
type Factory<T = unknown> = (dependencies: Readonly<Record<string, unknown>>) => T
type NormalizedBinding<T = unknown> = Readonly<{
  deps: NormalizedDependencies
  factory: Factory<T>
}>

type CompileRoot =
  | Readonly<{ kind: 'exact'; path: SemanticPath }>
  | Readonly<{ kind: 'selector'; selector: Selector }>

const bindingName = (name: unknown): string => JSON.stringify(name) ?? String(name)

function canonicalPath(path: unknown, role: string): string {
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
  return path
}

function semanticPath(path: unknown, role: string): SemanticPath {
  const normalized = canonicalPath(path, role)
  if (normalized.includes('*')) {
    throw new Error(`${role} ${bindingName(normalized)} must not contain reserved wildcards "*" or "**"`)
  }
  return normalized as SemanticPath
}

function selector(path: unknown, role: string): Selector {
  const normalized = canonicalPath(path, role)
  if (normalized.includes('*')) globOf(normalized.slice(1))
  return normalized as Selector
}

function compileRoot(path: unknown): CompileRoot {
  const normalized = canonicalPath(path, 'Compile root')
  if (!normalized.includes('*')) {
    return Object.freeze({ kind: 'exact', path: normalized as SemanticPath })
  }
  globOf(normalized.slice(1))
  return Object.freeze({ kind: 'selector', selector: normalized as Selector })
}

function exactDependency(path: unknown): ExactDependency {
  return Object.freeze({
    [DEPENDENCY]: 'one' as const,
    path: semanticPath(path, 'one dependency'),
  })
}

function collectionDependency(selectors: readonly unknown[]): CollectionDependency {
  if (selectors.length === 0) throw new TypeError('many requires at least one selector')
  return Object.freeze({
    [DEPENDENCY]: 'many' as const,
    selectors: Object.freeze(selectors.map(value => selector(value, 'many selector'))),
  })
}

function dependencyKind(dependency: object): unknown {
  return (dependency as Record<PropertyKey, unknown>)[DEPENDENCY]
}

function normalizeDependency(dependency: unknown): NormalizedDependency {
  if (dependency === null || typeof dependency !== 'object' || Array.isArray(dependency)) {
    throw new TypeError('Binding dependency must be declared with one() or many()')
  }

  const input = dependency as Record<PropertyKey, unknown>
  const kind = dependencyKind(dependency)
  if (kind === 'one') return exactDependency(input['path'])
  if (kind === 'many') {
    const selectors = input['selectors']
    if (!Array.isArray(selectors)) {
      throw new TypeError('Binding dependency must be declared with one() or many()')
    }
    return collectionDependency(selectors)
  }
  throw new TypeError('Binding dependency must be declared with one() or many()')
}

function normalizeDependencies(deps: unknown): NormalizedDependencies {
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
    throw new TypeError('Binding dependencies must be an object')
  }

  const input = deps as Record<PropertyKey, unknown>
  const normalized: Record<string, NormalizedDependency> = {}
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

function normalizeBinding<T>(deps: unknown, factory: unknown): NormalizedBinding<T> {
  if (typeof factory !== 'function') throw new TypeError('Binding factory must be a function')
  return Object.freeze({
    deps: normalizeDependencies(deps),
    factory: factory as Factory<T>,
  })
}

export function one<T = unknown>(path: string): OneDependency<T> {
  if (arguments.length !== 1) throw new TypeError('one accepts exactly one argument')
  return exactDependency(path) as OneDependency<T>
}

export function many<T = unknown>(...selectors: string[]): ManyDependency<T> {
  return collectionDependency(selectors) as ManyDependency<T>
}

export function value<T>(input: T): Binding<T> {
  if (arguments.length !== 1) throw new TypeError('value accepts exactly one argument')
  return normalizeBinding<T>({}, () => input)
}

export function derive<const D extends Dependencies, T>(
  deps: D,
  factory: (dependencies: ResolvedDependencies<D>) => T,
): Binding<T> {
  if (arguments.length !== 2) throw new TypeError('derive accepts exactly two arguments')
  return normalizeBinding<T>(deps, factory)
}

export function construct<const D extends Dependencies, T>(
  deps: D,
  Class: new (dependencies: ResolvedDependencies<D>) => T,
): Binding<T> {
  if (arguments.length !== 2) throw new TypeError('construct accepts exactly two arguments')
  if (typeof Class !== 'function') throw new TypeError('Binding class must be a constructor')
  return normalizeBinding<T>(
    deps,
    (dependencies: Readonly<Record<string, unknown>>) => (
      new Class(dependencies as ResolvedDependencies<D>)
    ),
  )
}

function normalizeBindings(bindings: unknown): Map<SemanticPath, NormalizedBinding> {
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new TypeError('Graph bindings must be an object')
  }

  const input = bindings as Record<PropertyKey, unknown>
  return new Map(Reflect.ownKeys(input).map(inputName => {
    const name = semanticPath(inputName, 'Binding name')
    const candidate = input[name]
    if (candidate === null || typeof candidate !== 'object') {
      throw new TypeError(`Binding ${bindingName(name)} must be a binding`)
    }

    const binding = candidate as Record<PropertyKey, unknown>
    return [name, normalizeBinding(binding['deps'], binding['factory'])]
  }))
}

/** Immutable RDK dependency graph. */
export class Graph<B extends Bindings = Bindings> {
  readonly #bindings: ReadonlyMap<SemanticPath, NormalizedBinding>

  constructor(bindings: ReadonlyMap<SemanticPath, NormalizedBinding>) {
    this.#bindings = bindings
    Object.freeze(this)
  }

  bindingOf<K extends keyof B & string>(name: K): B[K] | undefined
  bindingOf(name: string): Binding | undefined
  bindingOf(name: string): Binding | undefined {
    return this.#bindings.get(semanticPath(name, 'Binding name'))
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
      for (const [name, binding] of other.#bindings) merged.set(name, binding)
    })
    return new Graph(merged)
  }

  compile(): GraphValues<B>
  compile(roots: readonly string[]): Partial<GraphValues<B>>
  compile(roots?: readonly string[]): GraphValues<B> | Partial<GraphValues<B>> {
    if (roots !== undefined && !Array.isArray(roots)) {
      throw new TypeError('Compile roots must be an array of absolute semantic paths')
    }

    const selectors = new Map<Selector, (path: SemanticPath) => boolean>()
    const matcher = (pattern: Selector): ((path: SemanticPath) => boolean) => {
      let matches = selectors.get(pattern)
      if (matches === undefined) {
        const relative = globOf(pattern.slice(1))
        matches = path => relative(path.slice(1))
        selectors.set(pattern, matches)
      }
      return matches
    }
    const matchingNames = (patterns: readonly Selector[]): SemanticPath[] => [...this.#bindings.keys()]
      .filter(name => patterns.some(pattern => matcher(pattern)(name)))

    const normalizedRoots: readonly CompileRoot[] = roots === undefined
      ? [...this.#bindings.keys()].map(path => Object.freeze({ kind: 'exact' as const, path }))
      : roots.map(compileRoot)

    const values = new Map<SemanticPath, unknown>()
    const resolving: SemanticPath[] = []

    const resolveDependency = (
      dependency: NormalizedDependency,
      requiredBy: SemanticPath,
    ): unknown => {
      switch (dependency[DEPENDENCY]) {
        case 'one':
          return resolve(dependency.path, requiredBy)
        case 'many': {
          const record: Record<string, unknown> = {}
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
      }
    }

    const resolve = (name: SemanticPath, requiredBy?: SemanticPath): unknown => {
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
      switch (root.kind) {
        case 'exact':
          resolve(root.path)
          break
        case 'selector':
          for (const matched of matchingNames([root.selector])) resolve(matched)
          break
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
  return new Graph<B>(normalizeBindings(bindings))
}

export function merge(...graphs: readonly Graph[]): Graph {
  return graph({}).merge(...graphs)
}
