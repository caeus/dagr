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

function createRdkModule(context: vm.Context): vm.Module {
  const graphFacades = new WeakMap<object, nativeRdk.Graph>()

  const graphOf = (facade: unknown): nativeRdk.Graph => {
    if (facade === null || typeof facade !== 'object') {
      throw new TypeError('Can only merge another graph')
    }
    const graph = graphFacades.get(facade)
    if (graph === undefined) throw new TypeError('Can only merge another graph')
    return graph
  }

  const host = Object.freeze({
    one: (path: string) => nativeRdk.one(path),
    many: (...selectors: string[]) => nativeRdk.many(...selectors),
    value: (input: unknown) => nativeRdk.value(input),
    derive: (deps: unknown, factory: unknown) => nativeRdk.derive(
      deps as nativeRdk.Dependencies,
      factory as (dependencies: UnknownRecord) => unknown,
    ),
    construct: (deps: unknown, Class: unknown) => nativeRdk.construct(
      deps as nativeRdk.Dependencies,
      Class as new (dependencies: UnknownRecord) => unknown,
    ),
    graph: (bindings: unknown) => nativeRdk.graph(bindings as nativeRdk.Bindings),
    merge: (graph: nativeRdk.Graph, others: readonly unknown[]) => graph.merge(...others.map(graphOf)),
    mergeAll: (graphs: readonly unknown[]) => nativeRdk.merge(...graphs.map(graphOf)),
    bindingOf: (graph: nativeRdk.Graph, name: string) => graph.bindingOf(name),
    keys: (graph: nativeRdk.Graph) => [...graph.keys()],
    compile: (graph: nativeRdk.Graph, roots?: readonly string[]) => Object.entries(
      roots === undefined ? graph.compile() : graph.compile(roots),
    ),
    invoke: (binding: nativeRdk.Binding, dependencies: UnknownRecord) => binding.factory(dependencies),
    register: (facade: object, graph: nativeRdk.Graph) => graphFacades.set(facade, graph),
  })

  const namespace = vm.compileFunction(`
    const DEPENDENCY = Symbol.for('caeus/dagr/rdk#Dependency')

    const dependency = native => Object.freeze(native.path === undefined
      ? { [DEPENDENCY]: 'many', selectors: Object.freeze([...native.selectors]) }
      : { [DEPENDENCY]: 'one', path: native.path })

    const binding = native => {
      const deps = {}
      for (const [name, value] of Object.entries(native.deps)) {
        Object.defineProperty(deps, name, {
          value: dependency(value), enumerable: true, writable: false, configurable: false,
        })
      }
      return Object.freeze({
        deps: Object.freeze(deps),
        factory: dependencies => host.invoke(native, dependencies),
      })
    }

    const container = entries => {
      const result = Object.create(null)
      for (const [name, value] of entries) {
        Object.defineProperty(result, name, {
          value, enumerable: true, writable: false, configurable: false,
        })
      }
      return Object.freeze(result)
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
    const value = input => binding(host.value(input))
    const one = path => dependency(host.one(path))
    const many = (...selectors) => dependency(host.many(...selectors))
    const derive = (deps, factory) => binding(host.derive(deps, factory))
    const construct = (deps, Class) => binding(host.construct(deps, Class))

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
