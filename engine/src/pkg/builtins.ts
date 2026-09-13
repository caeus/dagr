import vm from 'node:vm'
import { stringify as stringifyToml } from 'smol-toml'
import { stringify as stringifyYaml } from 'yaml'
import { of as nativeGlobOf } from '#pkg/glob.js'
import * as nativeRdk from '#pkg/rdk.js'
import { createSandboxStringifier } from '#pkg/sandbox.js'

export const BUILTIN_PREFIX = 'dagr:'

type GlobPredicate = (path: string) => boolean
type GlobFactory = (pattern: string) => GlobPredicate

type UnknownRecord = Readonly<Record<string, unknown>>
type UnknownFunction = (...args: never[]) => unknown

function createGlobFactory(context: vm.Context): GlobFactory {
  const of = vm.compileFunction(`
    const native = compile(pattern)
    return Object.freeze(path => native(path))
  `, ['pattern'], {
    parsingContext: context,
    contextExtensions: [{ compile: nativeGlobOf }],
  }) as GlobFactory

  return Object.freeze(of)
}

/**
 * Exposes the native RDK through sandbox-realm functions and containers. The implementation stays
 * in rdk.ts; this code only prevents host-realm constructors from leaking through the VM boundary.
 */
function createRdkModule(context: vm.Context): vm.Module {
  const graphFacades = new WeakMap<object, nativeRdk.Graph>()

  const graphOf = (facade: unknown, position: number): nativeRdk.Graph => {
    if (facade !== null && typeof facade === 'object') {
      const graph = graphFacades.get(facade)
      if (graph !== undefined) return graph
    }
    throw new TypeError(`Can only merge another graph, got ${typeof facade} at ${position}`)
  }

  const host = Object.freeze({
    one: (args: readonly unknown[]) => Reflect.apply(
      nativeRdk.one,
      undefined,
      args,
    ) as nativeRdk.OneInput,
    many: (args: readonly unknown[]) => Reflect.apply(
      nativeRdk.many,
      undefined,
      args,
    ) as nativeRdk.ManyInput,
    value: (args: readonly unknown[]) => Reflect.apply(
      nativeRdk.value,
      undefined,
      args,
    ) as nativeRdk.Binding,
    derive: (args: readonly unknown[]) => Reflect.apply(
      nativeRdk.derive,
      undefined,
      args,
    ) as nativeRdk.Binding,
    construct: (args: readonly unknown[]) => Reflect.apply(
      nativeRdk.construct,
      undefined,
      args,
    ) as nativeRdk.Binding,
    graph: (bindings: unknown) => nativeRdk.graph(bindings as nativeRdk.Bindings),
    merge: (graph: nativeRdk.Graph, others: readonly unknown[]) => graph.merge(
      ...others.map((other, position) => graphOf(other, position)),
    ),
    mergeAll: (graphs: readonly unknown[]) => nativeRdk.merge(
      ...graphs.map((graph, position) => graphOf(graph, position)),
    ),
    bindingOf: (graph: nativeRdk.Graph, name: string) => graph.bindingOf(name),
    keys: (graph: nativeRdk.Graph) => [...graph.keys()],
    compile: (graph: nativeRdk.Graph, roots?: readonly string[]) => Object.entries(
      roots === undefined ? graph.compile() : graph.compile(roots),
    ),
    invoke: (binding: nativeRdk.Binding, inputs: UnknownRecord) => binding.factory(inputs),
    register: (facade: object, graph: nativeRdk.Graph) => graphFacades.set(facade, graph),
  })

  const namespace = vm.compileFunction(`
    const INPUT = Symbol.for('caeus/dagr/rdk#Input')

    const input = native => Object.freeze(native.path === undefined
      ? { [INPUT]: 'many', selectors: Object.freeze([...native.selectors]) }
      : { [INPUT]: 'one', path: native.path })

    const copy = (entries, target) => {
      for (const [name, value] of entries) {
        Object.defineProperty(target, name, {
          value, enumerable: true, writable: false, configurable: false,
        })
      }
      return Object.freeze(target)
    }
    const record = entries => copy(entries, {})
    const container = entries => copy(entries, Object.create(null))

    const binding = native => {
      const inputs = {}
      for (const [name, value] of Object.entries(native.inputs)) {
        Object.defineProperty(inputs, name, {
          value: input(value), enumerable: true, writable: false, configurable: false,
        })
      }

      const argumentsOf = resolved => {
        const result = {}
        for (const [name, value] of Object.entries(resolved)) {
          const declaration = native.inputs[name]
          Object.defineProperty(result, name, {
            value: declaration.path === undefined
              ? record(Object.entries(value))
              : value,
            enumerable: true,
            writable: false,
            configurable: false,
          })
        }
        return Object.freeze(result)
      }

      return Object.freeze({
        inputs: Object.freeze(inputs),
        factory: resolved => host.invoke(native, argumentsOf(resolved)),
      })
    }

    const wrap = native => {
      let facade
      facade = Object.freeze({
        bindingOf: name => {
          const found = host.bindingOf(native, name)
          return found === undefined ? undefined : binding(found)
        },
        keys: () => Object.freeze([...host.keys(native)])[Symbol.iterator](),
        merge: (...others) => wrap(host.merge(native, others)),
        compile: roots => container(host.compile(native, roots)),
      })
      host.register(facade, native)
      return facade
    }

    const graph = bindings => wrap(host.graph(bindings))
    const merge = (...graphs) => wrap(host.mergeAll(graphs))
    const value = (...args) => binding(host.value(args))
    const one = (...args) => input(host.one(args))
    const many = (...args) => input(host.many(args))
    const derive = (...args) => binding(host.derive(args))
    const construct = (...args) => binding(host.construct(args))

    return Object.freeze({ graph, merge, value, one, many, derive, construct })
  `, [], {
    parsingContext: context,
    contextExtensions: [{ host }],
  })() as Readonly<Record<string, UnknownFunction>>

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

  function builtin<T extends (...args: never[]) => unknown>(
    specifier: string,
    exportName: string,
    fn: T,
  ): readonly [string, vm.Module] {
    const namespace = vm.compileFunction(
      `return Object.freeze({ ${exportName}: fn })`,
      [],
      {
        parsingContext: context,
        contextExtensions: [{ fn }],
      },
    )()
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
