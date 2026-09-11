import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createBuiltinModules } from '#pkg/builtins.js'
import { createSandboxContext } from '#pkg/sandbox.js'

type Dependency = Readonly<{
  path?: string
  selectors?: readonly string[]
}>

type Binding = Readonly<{
  deps: Readonly<Record<string, Dependency>>
  factory: (dependencies: Readonly<Record<string, unknown>>) => unknown
}>

type Graph = Readonly<{
  bindingOf: (name: string) => Binding | undefined
  keys: () => IterableIterator<string>
  merge: (...others: Graph[]) => Graph
  compile: (roots?: readonly string[]) => Readonly<Record<string, unknown>>
}>

type Rdk = Readonly<{
  graph: (bindings: Record<string, Binding>) => Graph
  merge: (...graphs: Graph[]) => Graph
  value: (input: unknown) => Binding
  one: (path: string) => Dependency
  many: (...selectors: string[]) => Dependency
  derive: (
    deps: Record<string, Dependency>,
    factory: (dependencies: Readonly<Record<string, unknown>>) => unknown,
  ) => Binding
  construct: (
    deps: Record<string, Dependency>,
    Class: new (dependencies: Readonly<Record<string, unknown>>) => unknown,
  ) => Binding
}>

async function rdkModule() {
  const builtins = createBuiltinModules(createSandboxContext())
  const module = builtins.get('dagr:rdk')
  assert.ok(module)

  await module.link(specifier => {
    const dependency = builtins.get(specifier)
    assert.ok(dependency, `Unknown built-in dependency ${specifier}`)
    return dependency
  })
  await module.evaluate()

  return module.namespace as unknown as { readonly default: Rdk } & Rdk
}

describe('dagr:rdk', () => {
  it('registers the RDK as a native built-in with named and default exports', async () => {
    const namespace = await rdkModule()
    assert.deepEqual(
      Object.keys(namespace).sort(),
      ['construct', 'default', 'derive', 'graph', 'many', 'merge', 'one', 'value'],
    )
    assert.equal(namespace.default.graph, namespace.graph)
    assert.equal(namespace.default.many, namespace.many)
  })

  it('resolves named exact and collection dependencies', async () => {
    const rdk = (await rdkModule()).default
    const graph = rdk.graph({
      '/prefix': rdk.value('commands:'),
      '/command/build/typescript': rdk.value('tsc'),
      '/command/test/vitest': rdk.value('vitest'),
      '/result': rdk.derive(
        { prefix: rdk.one('/prefix'), commands: rdk.many('/command/**') },
        dependencies => {
          const prefix = dependencies.prefix as string
          const commands = dependencies.commands as Readonly<Record<string, string>>
          return `${prefix}${Object.values(commands).join(',')}`
        },
      ),
    })

    const container = graph.compile(['/result'])
    assert.equal(container['/result'], 'commands:tsc,vitest')
    assert.deepEqual(Object.keys(container), [
      '/prefix',
      '/command/build/typescript',
      '/command/test/vitest',
      '/result',
    ])
  })

  it('supports glob compile roots and keeps unrelated bindings lazy', async () => {
    const rdk = (await rdkModule()).default
    let ignored = false
    const graph = rdk.graph({
      '/shared': rdk.value('shared'),
      '/target/ci/build': rdk.derive(
        { shared: rdk.one('/shared') },
        ({ shared }) => `${shared as string}:build`,
      ),
      '/target/ci/test': rdk.value('test'),
      '/target/publish/pack': rdk.value('pack'),
      '/ignored': rdk.derive({}, () => { ignored = true }),
    })

    const container = graph.compile(['/target/ci/*'])
    assert.deepEqual(Object.keys(container), ['/shared', '/target/ci/build', '/target/ci/test'])
    assert.equal(ignored, false)
  })

  it('merges immutably with right-biased replacement and stable key order', async () => {
    const rdk = (await rdkModule()).default
    const first = rdk.graph({
      '/first': rdk.value(1),
      '/replace': rdk.value('old'),
    })
    const second = rdk.graph({
      '/replace': rdk.value('new'),
      '/last': rdk.value(3),
    })

    const merged = first.merge(second)
    assert.deepEqual([...merged.keys()], ['/first', '/replace', '/last'])
    assert.equal(merged.compile()['/replace'], 'new')
    assert.equal(first.compile()['/replace'], 'old')
    assert.deepEqual([...rdk.merge().keys()], [])
  })

  it('exposes frozen dependency declarations and bindings', async () => {
    const rdk = (await rdkModule()).default
    const dependency = rdk.many('/file/*', '/generated/**')
    const binding = rdk.derive({ files: dependency }, ({ files }) => files)
    const graph = rdk.graph({ '/selection': binding })

    assert.equal(Object.isFrozen(dependency), true)
    assert.equal(Object.isFrozen(dependency.selectors), true)
    assert.equal(Object.isFrozen(binding), true)
    assert.equal(Object.isFrozen(binding.deps), true)
    assert.equal(Object.isFrozen(graph), true)
  })

  it('validates semantic paths and dependency declarations', async () => {
    const rdk = (await rdkModule()).default
    assert.throws(() => rdk.one('relative'), /must start with/)
    assert.throws(() => rdk.one('/file/**'), /reserved wildcards/)
    assert.throws(() => rdk.many(), /at least one selector/)
    assert.throws(() => rdk.many('/file/foo*'), /Invalid Dagr glob pattern/)
    assert.throws(
      () => rdk.graph({ '/bad/*': rdk.value(1) }),
      /reserved wildcards/,
    )
    assert.throws(
      () => rdk.derive({ value: '/value' as unknown as Dependency }, () => 1),
      /one\(\) or many\(\)/,
    )
  })

  it('reports missing exact dependencies and cycles', async () => {
    const rdk = (await rdkModule()).default
    const missing = rdk.graph({
      '/greeting': rdk.derive(
        { name: rdk.one('/name') },
        ({ name }) => `hello ${name as string}`,
      ),
    })
    assert.throws(
      () => missing.compile(['/greeting']),
      /Missing binding "\/name" required by "\/greeting"/,
    )

    const circular = rdk.graph({
      '/a': rdk.derive({ b: rdk.one('/b') }, ({ b }) => b),
      '/b': rdk.derive({ a: rdk.one('/a') }, ({ a }) => a),
    })
    assert.throws(() => circular.compile(), /Circular dependency: \/a -> \/b -> \/a/)
  })

  it('constructs classes and treats promises as ordinary synchronous values', async () => {
    const rdk = (await rdkModule()).default
    class Box {
      readonly value: unknown
      constructor({ value }: Readonly<Record<string, unknown>>) {
        this.value = value
      }
    }

    const promise = Promise.resolve(42)
    const graph = rdk.graph({
      '/promise': rdk.value(promise),
      '/box': rdk.construct({ value: rdk.one('/promise') }, Box),
    })
    const container = graph.compile()

    assert.equal(container['/promise'], promise)
    assert.equal((container['/box'] as Box).value, promise)
  })
})
