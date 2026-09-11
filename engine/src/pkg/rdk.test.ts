import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import {
  construct,
  derive,
  graph,
  many,
  merge,
  one,
  value,
} from '#pkg/rdk.js'
import { createBuiltinModules } from '#pkg/builtins.js'
import { createSandboxContext } from '#pkg/sandbox.js'

async function sandboxRdk() {
  const builtins = createBuiltinModules(createSandboxContext())
  const module = builtins.get('dagr:rdk')
  assert.ok(module)
  await module.link(() => { throw new Error('dagr:rdk has no VM imports') })
  await module.evaluate()
  return module.namespace
}

describe('native RDK', () => {
  it('resolves named exact and collection dependencies', () => {
    const dagr = graph({
      '/prefix': value('commands:'),
      '/command/build/typescript': value('tsc'),
      '/command/test/vitest': value('vitest'),
      '/result': derive(
        { prefix: one<string>('/prefix'), commands: many<string>('/command/**') },
        ({ prefix, commands }) => `${prefix}${Object.values(commands).join(',')}`,
      ),
    })

    const container = dagr.compile(['/result'])
    assert.equal(container['/result'], 'commands:tsc,vitest')
    assert.deepEqual(Object.keys(container), [
      '/prefix',
      '/command/build/typescript',
      '/command/test/vitest',
      '/result',
    ])
  })

  it('supports glob compile roots and keeps unrelated bindings lazy', () => {
    let ignored = false
    const dagr = graph({
      '/shared': value('shared'),
      '/target/ci/build': derive(
        { shared: one<string>('/shared') },
        ({ shared }) => `${shared}:build`,
      ),
      '/target/ci/test': value('test'),
      '/target/publish/pack': value('pack'),
      '/ignored': derive({}, () => { ignored = true }),
    })

    const container = dagr.compile(['/target/ci/*'])
    assert.deepEqual(Object.keys(container), ['/shared', '/target/ci/build', '/target/ci/test'])
    assert.equal(ignored, false)
  })

  it('merges immutably with right-biased replacement and stable key order', () => {
    const first = graph({
      '/first': value(1),
      '/replace': value('old'),
    })
    const second = graph({
      '/replace': value('new'),
      '/last': value(3),
    })

    const merged = first.merge(second)
    assert.deepEqual([...merged.keys()], ['/first', '/replace', '/last'])
    assert.equal(merged.compile()['/replace'], 'new')
    assert.equal(first.compile()['/replace'], 'old')
    assert.deepEqual([...merge().keys()], [])
  })

  it('exposes frozen dependency declarations and bindings', () => {
    const dependency = many('/file/*', '/generated/**')
    const binding = derive({ files: dependency }, ({ files }) => files)
    const dagr = graph({ '/selection': binding })

    assert.equal(Object.isFrozen(dependency), true)
    assert.equal(Object.isFrozen(dependency.selectors), true)
    assert.equal(Object.isFrozen(binding), true)
    assert.equal(Object.isFrozen(binding.deps), true)
    assert.equal(Object.isFrozen(dagr), true)
  })

  it('validates semantic paths and dependency declarations', () => {
    assert.throws(() => one('relative'), /must start with/)
    assert.throws(() => one('/file/**'), /reserved wildcards/)
    assert.throws(() => many(), /at least one selector/)
    assert.throws(() => many('/file/foo*'), /Invalid Dagr glob pattern/)
    assert.throws(
      () => graph({ '/bad/*': value(1) }),
      /reserved wildcards/,
    )
    assert.throws(
      () => derive({ value: '/value' as never }, () => 1),
      /one\(\) or many\(\)/,
    )
  })

  it('reports missing exact dependencies and cycles', () => {
    const missing = graph({
      '/greeting': derive(
        { name: one<string>('/name') },
        ({ name }) => `hello ${name}`,
      ),
    })
    assert.throws(
      () => missing.compile(['/greeting']),
      /Missing binding "\/name" required by "\/greeting"/,
    )

    const circular = graph({
      '/a': derive({ b: one('/b') }, ({ b }) => b),
      '/b': derive({ a: one('/a') }, ({ a }) => a),
    })
    assert.throws(() => circular.compile(), /Circular dependency: \/a -> \/b -> \/a/)
  })

  it('constructs classes and treats promises as ordinary synchronous values', () => {
    class Box {
      constructor(readonly dependencies: Readonly<{ value: Promise<number> }>) {}
    }

    const promise = Promise.resolve(42)
    const dagr = graph({
      '/promise': value(promise),
      '/box': construct({ value: one<Promise<number>>('/promise') }, Box),
    })
    const container = dagr.compile()

    assert.equal(container['/promise'], promise)
    assert.equal(container['/box'].dependencies.value, promise)
  })
})

describe('dagr:rdk bridge', () => {
  it('exports sandbox-realm facades over the native implementation', async () => {
    const namespace = await sandboxRdk()
    assert.deepEqual(
      Object.keys(namespace).sort(),
      ['construct', 'default', 'derive', 'graph', 'many', 'merge', 'one', 'value'],
    )

    const rdk = namespace.default as {
      graph: (bindings: Record<string, unknown>) => {
        compile: () => Record<string, unknown>
      }
      value: (input: unknown) => unknown
    }
    const dagr = rdk.graph({ '/answer': rdk.value(42) })
    assert.equal(dagr.compile()['/answer'], 42)
  })

  it('passes dependency records to callbacks in the sandbox realm', async () => {
    const context = createSandboxContext()
    const builtins = createBuiltinModules(context)
    const consumer = new vm.SourceTextModule(`
      import rdk from 'dagr:rdk'

      const dagr = rdk.graph({
        '/file/example': rdk.value('example'),
        '/result': rdk.derive({ files: rdk.many('/file/**') }, ({ files }) => (
          Object.getPrototypeOf(files) === Object.prototype
          && files['/file/example'] === 'example'
        )),
      })

      export default dagr.compile(['/result'])['/result']
    `, { context })

    await consumer.link(specifier => {
      const builtin = builtins.get(specifier)
      assert.ok(builtin, `Unknown built-in ${specifier}`)
      return builtin
    })
    await consumer.evaluate()
    assert.equal(consumer.namespace.default, true)
  })
})
