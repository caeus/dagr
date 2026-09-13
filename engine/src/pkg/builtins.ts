import vm from 'node:vm'
import { stringify as stringifyToml } from 'smol-toml'
import { stringify as stringifyYaml } from 'yaml'
import { of as nativeGlobOf } from '#pkg/glob.js'
import * as nativeRdk from '#pkg/rdk.js'
import {
  createSandboxArray,
  createSandboxContainer,
  createSandboxFunction,
  createSandboxRecord,
  createSandboxStringifier,
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

/**
 * Exposes the native RDK through sandbox-realm functions and containers. RDK behavior stays in
 * rdk.ts; this bridge only converts public functions and value shapes across the realm boundary.
 */
function createRdkModule(context: vm.Context): vm.Module {
  const graphFacades = new WeakMap<object, nativeRdk.Graph>()

  const record = (
    entries: Iterable<readonly [PropertyKey, unknown]>,
  ): Readonly<Record<PropertyKey, unknown>> => createSandboxRecord(context, entries)

  const namedRecord = (
    entries: Iterable<readonly [string, unknown]>,
  ): UnknownRecord => record(entries) as UnknownRecord

  const resolution = (resolved: nativeRdk.InputResolution): nativeRdk.InputResolution => record([
    ['keys', namedRecord(Object.entries(resolved.keys))],
    ['patterns', namedRecord(Object.entries(resolved.patterns))],
  ]) as unknown as nativeRdk.InputResolution

  const inputFacade = (input: nativeRdk.Input): nativeRdk.Input => {
    const detailed = input as DetailedInput
    const entries: Array<readonly [PropertyKey, unknown]> = [
      [INPUT, 'input'],
      ['keys', createSandboxArray(context, input.keys)],
      ['patterns', createSandboxArray(context, input.patterns)],
      ['project', createSandboxFunction(
        context,
        (resolved: nativeRdk.InputResolution) => input.project(resolution(resolved)),
      )],
    ]
    if (detailed.path !== undefined) entries.push(['path', detailed.path])
    if (detailed.selectors !== undefined) {
      entries.push(['selectors', createSandboxArray(context, detailed.selectors)])
    }
    return record(entries) as unknown as nativeRdk.Input
  }

  const bindingFacade = (binding: nativeRdk.Binding): nativeRdk.Binding => {
    const inputs = namedRecord(Object.entries(binding.inputs).map(
      ([name, input]) => [name, inputFacade(input)] as const,
    ))
    const factory = createSandboxFunction(
      context,
      (resolved: UnknownRecord) => binding.factory(namedRecord(Object.entries(resolved))),
    )
    return record([
      ['inputs', inputs],
      ['factory', factory],
    ]) as unknown as nativeRdk.Binding
  }

  const graphOf = (facade: unknown, position: number): nativeRdk.Graph => {
    if (facade !== null && typeof facade === 'object') {
      const graph = graphFacades.get(facade)
      if (graph !== undefined) return graph
    }
    throw new TypeError(`Can only merge another graph, got ${typeof facade} at ${position}`)
  }

  const wrap = (native: nativeRdk.Graph): object => {
    const facade = record([
      ['bindingOf', createSandboxFunction(context, (name: string) => {
        const found = native.bindingOf(name)
        return found === undefined ? undefined : bindingFacade(found)
      })],
      ['keys', createSandboxFunction(context, () => (
        createSandboxArray(context, native.keys())[Symbol.iterator]()
      ))],
      ['merge', createSandboxFunction(context, (...others: unknown[]) => wrap(native.merge(
        ...others.map((other, position) => graphOf(other, position)),
      )))],
      ['compile', createSandboxFunction(context, (roots?: readonly string[]) => createSandboxContainer(
        context,
        Object.entries(roots === undefined ? native.compile() : native.compile(roots)),
      ))],
    ])
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

  const namespace = namedRecord([
    ['graph', graph],
    ['merge', merge],
    ['value', value],
    ['input', input],
    ['one', one],
    ['many', many],
    ['derive', derive],
    ['construct', construct],
  ]) as Readonly<Record<string, UnknownFunction>>
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
    const namespace = createSandboxRecord(context, [[exportName, fn]])
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
