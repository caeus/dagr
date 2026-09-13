import vm from 'node:vm'

export type SandboxStringifier = (value: unknown) => string
export type SandboxJsonParser = (source: string) => unknown

const OPTIONS: vm.CreateContextOptions = {
  name: 'dagr',
  codeGeneration: { strings: false, wasm: false },
}

type SandboxIntrinsics = Readonly<{
  Array: ArrayConstructor
  Function: FunctionConstructor
  JSON: JSON
  Math: Math
  Object: ObjectConstructor
}>

const intrinsics = new WeakMap<vm.Context, SandboxIntrinsics>()

function intrinsicsOf(context: vm.Context): SandboxIntrinsics {
  let found = intrinsics.get(context)
  if (found !== undefined) return found

  const global = vm.runInContext('globalThis', context) as SandboxIntrinsics
  found = Object.freeze({
    Array: global.Array,
    Function: global.Function,
    JSON: global.JSON,
    Math: global.Math,
    Object: global.Object,
  })
  intrinsics.set(context, found)
  return found
}

export function freezeInSandbox<T extends object>(context: vm.Context, value: T): T {
  const realm = intrinsicsOf(context)
  const prototype = Object.getPrototypeOf(value) === null
    ? null
    : typeof value === 'function'
      ? realm.Function.prototype
      : Array.isArray(value)
        ? realm.Array.prototype
        : realm.Object.prototype
  Object.setPrototypeOf(value, prototype)
  return Object.freeze(value)
}

export function createSandboxFunction<Args extends unknown[], Result>(
  context: vm.Context,
  implementation: (...args: Args) => Result,
): (...args: Args) => Result {
  return freezeInSandbox(context, (...args: Args): Result => Reflect.apply(
    implementation,
    undefined,
    args,
  ) as Result)
}

export function createSandboxContext(): vm.Context {
  return vm.createContext(Object.assign(Object.create(null), { Buffer }), OPTIONS)
}

export function createConfigSandboxContext(): vm.Context {
  const context = vm.createContext(Object.create(null), { ...OPTIONS, name: 'dagr-config' })
  const realm = intrinsicsOf(context)

  Object.assign(context, {
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
  })
  Object.defineProperty(realm.Math, 'random', { value: undefined })
  Object.freeze(realm.Math)
  return context
}

function deepFreeze(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

export function createSandboxJsonParser(context: vm.Context): SandboxJsonParser {
  const parse = intrinsicsOf(context).JSON.parse
  return createSandboxFunction(
    context,
    (source: string) => deepFreeze(Reflect.apply(parse, undefined, [source])),
  )
}

export function createSandboxStringifier(
  context: vm.Context,
  implementation: SandboxStringifier,
): SandboxStringifier {
  return createSandboxFunction(context, implementation)
}
