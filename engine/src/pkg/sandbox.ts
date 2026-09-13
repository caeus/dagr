import vm from 'node:vm'

export type SandboxStringifier = (value: unknown) => string
export type SandboxJsonParser = (source: string) => unknown

const OPTIONS: vm.CreateContextOptions = {
  name: 'dagr',
  codeGeneration: { strings: false, wasm: false },
}

type SandboxGlobal = Readonly<{
  Array: ArrayConstructor
  Function: FunctionConstructor
  Math: Math
  Object: ObjectConstructor
}>

const globals = new WeakMap<vm.Context, SandboxGlobal>()

function globalOf(context: vm.Context): SandboxGlobal {
  let global = globals.get(context)
  if (global === undefined) {
    global = vm.runInContext('globalThis', context) as SandboxGlobal
    globals.set(context, global)
  }
  return global
}

export function createSandboxFunction<Args extends unknown[], Result>(
  context: vm.Context,
  implementation: (...args: Args) => Result,
): (...args: Args) => Result {
  const facade = (...args: Args): Result => Reflect.apply(
    implementation,
    undefined,
    args,
  ) as Result
  Object.setPrototypeOf(facade, globalOf(context).Function.prototype)
  return Object.freeze(facade)
}

export function createSandboxArray<T>(
  context: vm.Context,
  values: Iterable<T>,
): readonly T[] {
  const ArrayCtor = globalOf(context).Array
  const result = Reflect.construct(ArrayCtor, []) as T[]
  for (const value of values) Reflect.apply(ArrayCtor.prototype.push, result, [value])
  return Object.freeze(result)
}

function sandboxObject(
  context: vm.Context,
  entries: Iterable<readonly [PropertyKey, unknown]>,
  nullPrototype: boolean,
): Readonly<Record<PropertyKey, unknown>> {
  const ObjectCtor = globalOf(context).Object
  const result = (nullPrototype
    ? Reflect.apply(ObjectCtor.create, ObjectCtor, [null])
    : Reflect.construct(ObjectCtor, [])) as Record<PropertyKey, unknown>

  for (const [key, value] of entries) {
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  return Object.freeze(result)
}

export function createSandboxRecord(
  context: vm.Context,
  entries: Iterable<readonly [PropertyKey, unknown]>,
): Readonly<Record<PropertyKey, unknown>> {
  return sandboxObject(context, entries, false)
}

export function createSandboxContainer(
  context: vm.Context,
  entries: Iterable<readonly [PropertyKey, unknown]>,
): Readonly<Record<PropertyKey, unknown>> {
  return sandboxObject(context, entries, true)
}

function jsonValue(context: vm.Context, value: unknown): unknown {
  if (Array.isArray(value)) {
    return createSandboxArray(context, value.map(child => jsonValue(context, child)))
  }
  if (value !== null && typeof value === 'object') {
    return createSandboxRecord(
      context,
      Object.entries(value).map(([key, child]) => [key, jsonValue(context, child)] as const),
    )
  }
  return value
}

export function createSandboxContext(): vm.Context {
  return vm.createContext(Object.assign(Object.create(null), { Buffer }), OPTIONS)
}

export function createConfigSandboxContext(): vm.Context {
  const context = vm.createContext(Object.assign(Object.create(null), {
    Atomics: undefined,
    Buffer: undefined,
    Date: undefined,
    FinalizationRegistry: undefined,
    Function: undefined,
    Intl: undefined,
    SharedArrayBuffer: undefined,
    WeakRef: undefined,
    WebAssembly: undefined,
    console: undefined,
    eval: undefined,
  }), { ...OPTIONS, name: 'dagr-config' })

  const math = globalOf(context).Math
  Object.defineProperty(math, 'random', { value: undefined })
  Object.freeze(math)
  return context
}

export function createSandboxJsonParser(context: vm.Context): SandboxJsonParser {
  return createSandboxFunction(
    context,
    (source: string) => jsonValue(context, JSON.parse(source)),
  )
}

export function createSandboxStringifier(
  context: vm.Context,
  implementation: SandboxStringifier,
): SandboxStringifier {
  return createSandboxFunction(context, implementation)
}
