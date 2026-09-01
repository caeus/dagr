import vm from 'node:vm'

export type SandboxStringifier = (value: unknown) => string

export function createSandboxContext(): vm.Context {
  return vm.createContext(Object.assign(Object.create(null), { Buffer }), {
    name: 'dagr',
    codeGeneration: { strings: false, wasm: false },
  })
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
