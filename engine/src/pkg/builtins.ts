import vm from 'node:vm'
import { stringify as stringifyToml } from 'smol-toml'
import { stringify as stringifyYaml } from 'yaml'
import { of as nativeGlobOf } from '#pkg/glob.js'
import * as nativeRdk from '#pkg/rdk.js'
import {
  createSandboxFunction,
  createSandboxStringifier,
  freezeInSandbox,
} from '#pkg/sandbox.js'

export const BUILTIN_PREFIX = 'dagr:'

const INPUT = Symbol.for('caeus/dagr/rdk#Input')

type GlobPredicate = (path: string) => boolean
type GlobFactory = (pattern: string) => GlobPredicate
type UnknownRecord = Readonly<Record<string, unknown>>
type UnknownFunction = (...args: never[]) => unknown
type DetailedInput = nativeRdk.Input & Readonly<{
  path?: string
  selectors?: readonly string[]
}>

function createGlobFactory(context: vm.Context): GlobFactory {
  return createSandboxFunction(context, (pattern: string) => {
    const native = nativeGlobOf(pattern)
    return createSandboxFunction(context, (path: string) => native(path))
  })
}

/** Exposes native RDK behavior through small sandbox-realm facades. */
function createRdkModule(context: vm.Context): vm.Module {
  const graphFacades = new WeakMap<object, nativeRdk.Graph>()
  const freeze = <T extends object>(value: T): T => freezeInSandbox(context, value)

  const inputFacade = (input: nativeRdk.Input): nativeRdk.Input => {
    const detailed = input as DetailedInput
    return freeze({
      [INPUT]: 'input',
      keys: freeze([...input.keys]),
      patterns: freeze([...input.patterns]),
      project: createSandboxFunction(context, (resolved: nativeRdk.InputResolution) => input.project(
        freeze({
          keys: freeze({ ...resolved.keys }),
          patterns: freeze({ ...resolved.patterns }),
        }),
      )),
      ...(detailed.path === undefined ? {} : { path: detailed.path }),
      ...(detailed.selectors === undefined
        ? {}
        : { selectors: freeze([...detailed.selectors]) }),
    }) as unknown as nativeRdk.Input
  }

  const bindingFacade = (binding: nativeRdk.Binding): nativeRdk.Binding => freeze({
    inputs: freeze(Object.fromEntries(
      Object.entries(binding.inputs).map(([name, input]) => [name, inputFacade(input)]),
    )),
    factory: createSandboxFunction(
      context,
      (resolved: UnknownRecord) => binding.factory(freeze({ ...resolved })),
    ),
  }) as unknown as nativeRdk.Binding

  const graphOf = (facade: unknown, position: number): nativeRdk.Graph => {
    if (facade !== null && typeof facade === 'object') {
      const graph = graphFacades.get(facade)
      if (graph !== undefined) return graph
    }
    throw new TypeError(`Can only merge another graph, got ${typeof facade} at ${position}`)
  }

  const wrap = (native: nativeRdk.Graph): object => {
    const facade = freeze({
      bindingOf: createSandboxFunction(context, (name: string) => {
        const found = native.bindingOf(name)
        return found === undefined ? undefined : bindingFacade(found)
      }),
      keys: createSandboxFunction(
        context,
        () => freeze([...native.keys()])[Symbol.iterator](),
      ),
      merge: createSandboxFunction(context, (...others: unknown[]) => wrap(native.merge(
        ...others.map((other, position) => graphOf(other, position)),
      ))),
      compile: createSandboxFunction(context, (roots?: readonly string[]) => Object.freeze(
        Object.assign(
          Object.create(null),
          roots === undefined ? native.compile() : native.compile(roots),
        ),
      )),
    })
    graphFacades.set(facade, native)
    return facade
  }

  const graph = createSandboxFunction(
    context,
    (bindings: unknown) => wrap(nativeRdk.graph(bindings as nativeRdk.Bindings)),
  )
  const merge = createSandboxFunction(context, (...graphs: unknown[]) => wrap(nativeRdk.merge(
    ...graphs.map((candidate, position) => graphOf(candidate, position)),
  )))
  const value = createSandboxFunction(context, (...args: unknown[]) => bindingFacade(
    Reflect.apply(nativeRdk.value, undefined, args) as nativeRdk.Binding,
  ))
  const input = createSandboxFunction(context, (...args: unknown[]) => inputFacade(
    Reflect.apply(nativeRdk.input, undefined, args) as nativeRdk.Input,
  ))
  const one = createSandboxFunction(context, (...args: unknown[]) => inputFacade(
    Reflect.apply(nativeRdk.one, undefined, args) as nativeRdk.Input,
  ))
  const many = createSandboxFunction(context, (...args: unknown[]) => inputFacade(
    Reflect.apply(nativeRdk.many, undefined, args) as nativeRdk.Input,
  ))
  const derive = createSandboxFunction(context, (...args: unknown[]) => bindingFacade(
    Reflect.apply(nativeRdk.derive, undefined, args) as nativeRdk.Binding,
  ))
  const construct = createSandboxFunction(context, (...args: unknown[]) => bindingFacade(
    Reflect.apply(nativeRdk.construct, undefined, args) as nativeRdk.Binding,
  ))

  const namespace = freeze({ graph, merge, value, input, one, many, derive, construct }) as Readonly<
    Record<string, UnknownFunction>
  >
  const names = Object.keys(namespace)

  return new vm.SyntheticModule(
    ['default', ...names],
    function () {
      this.setExport('default', namespace)
      for (const name of names) this.setExport(name, namespace[name])
    },
    { context, identifier: 'dagr:rdk' },
  )
}

export function createBuiltinModules(context: vm.Context): ReadonlyMap<string, vm.Module> {
  const freeze = <T extends object>(value: T): T => freezeInSandbox(context, value)
  const globOf = createGlobFactory(context)
  return new Map([
    builtin(
      'dagr:yaml',
      'stringify',
      createSandboxStringifier(
        context,
        value => stringifyYaml(structuredClone(value)),
      ),
    ),
    builtin(
      'dagr:toml',
      'stringify',
      createSandboxStringifier(
        context,
        value => stringifyToml(
          structuredClone(value) as Record<string, unknown>,
        ),
      ),
    ),
    builtin('dagr:glob', 'of', globOf),
    ['dagr:rdk', createRdkModule(context)],
  ])

  function builtin<Args extends unknown[], Result>(
    specifier: string,
    exportName: string,
    fn: (...args: Args) => Result,
  ): readonly [string, vm.Module] {
    const namespace = freeze({ [exportName]: fn })
    return [
      specifier,
      new vm.SyntheticModule(
        ['default', exportName],
        function () {
          this.setExport('default', namespace)
          this.setExport(exportName, fn)
        },
        { context, identifier: specifier },
      ),
    ]
  }
}
