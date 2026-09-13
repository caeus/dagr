import { of as globOf } from '#pkg/glob.js'

declare const INPUT_VALUE: unique symbol
declare const BINDING_VALUE: unique symbol
declare const SEMANTIC_PATH_VALUE: unique symbol
declare const SELECTOR_VALUE: unique symbol

export interface Input<T = unknown> {
  readonly [INPUT_VALUE]?: T
}

export interface OneInput<T = unknown> extends Input<T> {
  readonly path: string
  readonly selectors?: never
}

export interface ManyInput<T = unknown> extends Input<Readonly<Record<string, T>>> {
  readonly selectors: readonly string[]
  readonly path?: never
}

export type AnyInput = OneInput | ManyInput
export type Inputs = Readonly<Record<string, AnyInput>>
export type ResolvedInputs<I extends Inputs> = Readonly<{
  [K in keyof I]: I[K] extends Input<infer T> ? T : never
}>

export interface Binding<T = unknown> {
  readonly inputs: Inputs
  readonly factory: (inputs: Readonly<Record<string, unknown>>) => T
  readonly [BINDING_VALUE]?: T
}

export type Bindings = Readonly<Record<string, Binding>>
export type BindingValue<B> = B extends Binding<infer T> ? T : never
export type GraphValues<B extends Bindings> = Readonly<{
  [K in keyof B]: BindingValue<B[K]>
}>

type SemanticPath = string & { readonly [SEMANTIC_PATH_VALUE]: true }
type Selector = string & { readonly [SELECTOR_VALUE]: true }

const INPUT = Symbol.for('caeus/dagr/rdk#Input')

type ExactInput = Readonly<OneInput & {
  readonly [INPUT]: 'one'
  readonly path: SemanticPath
}>

type CollectionInput = Readonly<ManyInput & {
  readonly [INPUT]: 'many'
  readonly selectors: readonly Selector[]
}>

type NormalizedInput = ExactInput | CollectionInput
type NormalizedInputs = Readonly<Record<string, NormalizedInput>>
type Factory<T = unknown> = (inputs: Readonly<Record<string, unknown>>) => T
type NormalizedBinding<T = unknown> = Readonly<{
  inputs: NormalizedInputs
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

function exactInput(path: unknown): ExactInput {
  return Object.freeze({
    [INPUT]: 'one' as const,
    path: semanticPath(path, 'one input'),
  })
}

function collectionInput(selectors: readonly unknown[]): CollectionInput {
  if (selectors.length === 0) throw new TypeError('many requires at least one selector')
  return Object.freeze({
    [INPUT]: 'many' as const,
    selectors: Object.freeze(selectors.map(value => selector(value, 'many selector'))),
  })
}

function inputKind(input: object): unknown {
  return (input as Record<PropertyKey, unknown>)[INPUT]
}

function normalizeInput(input: unknown): NormalizedInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Binding input must be declared with one() or many()')
  }

  const value = input as Record<PropertyKey, unknown>
  const kind = inputKind(input)
  if (kind === 'one') return exactInput(value['path'])
  if (kind === 'many') {
    const selectors = value['selectors']
    if (!Array.isArray(selectors)) {
      throw new TypeError('Binding input must be declared with one() or many()')
    }
    return collectionInput(selectors)
  }
  throw new TypeError('Binding input must be declared with one() or many()')
}

function normalizeInputs(inputs: unknown): NormalizedInputs {
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new TypeError('Binding inputs must be an object')
  }

  const values = inputs as Record<PropertyKey, unknown>
  const normalized: Record<string, NormalizedInput> = {}
  for (const key of Reflect.ownKeys(values)) {
    if (typeof key !== 'string') {
      throw new TypeError('Binding input names must be strings')
    }
    Object.defineProperty(normalized, key, {
      value: normalizeInput(values[key]),
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  return Object.freeze(normalized)
}

function normalizeBinding<T>(inputs: unknown, factory: unknown): NormalizedBinding<T> {
  if (typeof factory !== 'function') throw new TypeError('Binding factory must be a function')
  return Object.freeze({
    inputs: normalizeInputs(inputs),
    factory: factory as Factory<T>,
  })
}

export function one<T = unknown>(path: string): OneInput<T> {
  if (arguments.length !== 1) throw new TypeError('one accepts exactly one argument')
  return exactInput(path) as OneInput<T>
}

export function many<T = unknown>(...selectors: string[]): ManyInput<T> {
  return collectionInput(selectors) as ManyInput<T>
}

export function value<T>(input: T): Binding<T> {
  if (arguments.length !== 1) throw new TypeError('value accepts exactly one argument')
  return normalizeBinding<T>({}, () => input)
}

export function derive<const I extends Inputs, T>(
  inputs: I,
  factory: (inputs: ResolvedInputs<I>) => T,
): Binding<T> {
  if (arguments.length !== 2) throw new TypeError('derive accepts exactly two arguments')
  return normalizeBinding<T>(inputs, factory)
}

export function construct<const I extends Inputs, T>(
  inputs: I,
  Class: new (inputs: ResolvedInputs<I>) => T,
): Binding<T> {
  if (arguments.length !== 2) throw new TypeError('construct accepts exactly two arguments')
  if (typeof Class !== 'function') throw new TypeError('Binding class must be a constructor')
  return normalizeBinding<T>(
    inputs,
    (resolved: Readonly<Record<string, unknown>>) => (
      new Class(resolved as ResolvedInputs<I>)
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
    return [name, normalizeBinding(binding['inputs'], binding['factory'])]
  }))
}

/** Immutable RDK graph. */
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

    const resolveInput = (
      input: NormalizedInput,
      requiredBy: SemanticPath,
    ): unknown => {
      switch (input[INPUT]) {
        case 'one':
          return resolve(input.path, requiredBy)
        case 'many': {
          const record: Record<string, unknown> = {}
          for (const matched of matchingNames(input.selectors)) {
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
        throw new Error(`Circular input: ${cycle}`)
      }

      resolving.push(name)
      try {
        const inputs: Record<string, unknown> = {}
        for (const [key, input] of Object.entries(current.inputs)) {
          Object.defineProperty(inputs, key, {
            value: resolveInput(input, name),
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
