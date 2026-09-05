import vm from 'node:vm'

export type SandboxStringifier = (value: unknown) => string
export type SandboxJsonParser = (source: string) => unknown

const OPTIONS: vm.CreateContextOptions = {
  name: 'dagr',
  codeGeneration: { strings: false, wasm: false },
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

  vm.runInContext(`
    Object.defineProperty(Math, 'random', { value: undefined })
    Object.freeze(Math)
  `, context)
  return context
}

export function createSandboxJsonParser(context: vm.Context): SandboxJsonParser {
  return vm.compileFunction(`
    const freeze = value => {
      if (value === null || typeof value !== 'object') return value
      Object.freeze(value)
      for (const child of Object.values(value)) freeze(child)
      return value
    }
    return freeze(JSON.parse(source))
  `, ['source'], { parsingContext: context }) as SandboxJsonParser
}

export function createSandboxStringifier(
  context: vm.Context,
  implementation: SandboxStringifier,
): SandboxStringifier {
  const stringify = vm.compileFunction(
    'return implementation(value)',
    ['value'],
    {
      parsingContext: context,
      contextExtensions: [{ implementation }],
    },
  ) as SandboxStringifier
  return Object.freeze(stringify)
}
