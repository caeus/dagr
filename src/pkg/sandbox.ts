import vm from 'node:vm'

const SAFE_GLOBALS = new Set([
  'Infinity',
  'NaN',
  'undefined',
  'globalThis',
  'Object',
  'Function',
  'Boolean',
  'Symbol',
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Number',
  'BigInt',
  'Math',
  'String',
  'RegExp',
  'Array',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'BigInt64Array',
  'BigUint64Array',
  'Float32Array',
  'Float64Array',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'ArrayBuffer',
  'DataView',
  'JSON',
  'Promise',
  'Reflect',
  'Proxy',
  'parseFloat',
  'parseInt',
  'isFinite',
  'isNaN',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'Buffer',
])

const LOCKDOWN = `
  const safeGlobals = new Set(${JSON.stringify([...SAFE_GLOBALS])})
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (!safeGlobals.has(name) && !Reflect.deleteProperty(globalThis, name))
      throw new Error(\`Cannot remove sandbox global: \${name}\`)
  }

  Reflect.deleteProperty(Math, 'random')

  const seen = new WeakSet()
  const harden = value => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return
    if (seen.has(value)) return
    seen.add(value)

    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ('value' in descriptor) harden(descriptor.value)
      if (descriptor.get) harden(descriptor.get)
      if (descriptor.set) harden(descriptor.set)
    }
    Object.freeze(value)
  }

  for (const name of safeGlobals) harden(globalThis[name])
  Object.freeze(globalThis)
`

export type SandboxStringifier = (value: unknown) => string

export function createSandboxContext(): vm.Context {
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    name: 'dagr',
    codeGeneration: { strings: false, wasm: false },
  })
  installBufferFacade(context)
  vm.runInContext(LOCKDOWN, context)
  return context
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

function installBufferFacade(context: vm.Context): void {
  const encodeBase64 = (value: string): string => Buffer.from(value).toString('base64')
  const from = vm.compileFunction(
    `
      if (typeof value !== 'string')
        throw new TypeError('Dagr Buffer.from accepts only strings')
      if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'utf-8')
        throw new TypeError('Dagr Buffer.from accepts only UTF-8 input')

      const base64 = encodeBase64(value)
      return Object.freeze({
        toString(outputEncoding) {
          if (outputEncoding !== 'base64')
            throw new TypeError("Dagr Buffer values support only toString('base64')")
          return base64
        }
      })
    `,
    ['value', 'encoding'],
    {
      parsingContext: context,
      contextExtensions: [{ encodeBase64 }],
    },
  )
  Object.freeze(from)

  const buffer = vm.runInContext('Object.create(null)', context) as object
  Object.defineProperty(buffer, 'from', {
    value: from,
    enumerable: true,
    writable: false,
    configurable: false,
  })
  Object.freeze(buffer)
  Object.defineProperty(context, 'Buffer', {
    value: buffer,
    enumerable: true,
    writable: false,
    configurable: false,
  })
}
