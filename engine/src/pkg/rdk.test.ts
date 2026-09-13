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
  it('injects named exact inputs', () => {
    const container = graph({
      '/name': value('caeus'),
      '/greeting': derive({ name: one<string>('/name') }, ({ name }) => `hello ${name}`),
    }).compile(['/greeting'])

    assert.equal(container['/name'], 'caeus')
    assert.equal(container['/greeting'], 'hello caeus')
  })

  it('constructs classes from one named input object', () => {
    class Greeter {
      constructor(readonly name: string) {}
      greet() { return `hello ${this.name}` }
    }

    const container = graph({
      '/name': value('caeus'),
      '/greeter': construct(
        { name: one<string>('/name') },
        class extends Greeter {
          constructor({ name }: Readonly<{ name: string }>) { super(name) }
        },
      ),
    }).compile(['/greeter'])

    assert.equal(container['/greeter']!.greet(), 'hello caeus')
  })

  it('compiles all bindings eagerly and once when roots are omitted', () => {
    let initialized = 0
    const dagr = graph({
      '/value': derive({}, () => ++initialized),
      '/copy': derive({ value: one<number>('/value') }, ({ value }) => value),
    })

    const container = dagr.compile()
    assert.equal(container['/value'], 1)
    assert.equal(container['/copy'], 1)
    assert.equal(initialized, 1)
  })

  it('rejects binding names that are not canonical absolute paths', () => {
    for (const [name, message] of [
      ['relative', /must start with/],
      ['/', /cannot be/],
      ['/trailing/', /must not end/],
      ['/double//slash', /must not contain "\/\/"/],
      ['/dot/./segment', /must not contain "\." or "\.\."/],
      ['/dot/../segment', /must not contain "\." or "\.\."/],
      ['/reserved/*', /reserved wildcards/],
      ['/reserved/**', /reserved wildcards/],
      ['/reserved/foo*', /reserved wildcards/],
    ] as const) {
      assert.throws(() => graph({ [name]: value(1) }), message)
    }
    assert.throws(
      () => graph({ [Symbol('binding')]: value(1) } as never),
      /absolute semantic path/,
    )
  })

  it('requires named input declarations to use one() or many()', () => {
    assert.throws(() => derive([] as never, String), /inputs must be an object/)
    assert.throws(() => derive(['/value'] as never, String), /inputs must be an object/)
    assert.throws(() => derive({ value: '/value' as never }, String), /one\(\) or many\(\)/)
    assert.throws(() => derive({ value: ['/value'] as never }, String), /one\(\) or many\(\)/)
    assert.throws(
      () => derive({ [Symbol('value')]: one('/value') } as never, String),
      /names must be strings/,
    )
  })

  it('validates one() as an exact semantic path', () => {
    for (const input of ['relative', '/', '/trailing/', '/double//slash', '/dot/./x']) {
      assert.throws(() => one(input))
    }
    assert.throws(() => one('/file/**'), /reserved wildcards/)
    assert.throws(() => one('/file/*'), /reserved wildcards/)
    assert.throws(() => Reflect.apply(one, undefined, ['/a', '/b']), /exactly one argument/)
  })

  it('validates many() selectors and requires at least one', () => {
    assert.throws(() => many(), /at least one selector/)
    assert.throws(() => many('relative'), /must start with/)
    assert.throws(
      () => Reflect.apply(many, undefined, ['/file/**', { selector: '/command/**' }]),
      /absolute semantic path/,
    )
  })

  it('resolves * as exactly one path segment', () => {
    const files = graph({
      '/file/package-json': value(1),
      '/file/tsconfig': value(2),
      '/file/generated/types': value(3),
      '/files': value(4),
      '/selection': derive({ files: many<number>('/file/*') }, ({ files }) => files),
    }).compile(['/selection'])['/selection']!

    assert.deepEqual(files, {
      '/file/package-json': 1,
      '/file/tsconfig': 2,
    })
  })

  it('resolves ** across nested path segments', () => {
    const files = graph({
      '/file/package-json': value(1),
      '/file/generated/types': value(2),
      '/selection': derive({ files: many<number>('/file/**') }, ({ files }) => files),
    }).compile(['/selection'])['/selection']!

    assert.deepEqual(files, {
      '/file/package-json': 1,
      '/file/generated/types': 2,
    })
  })

  it('treats many() as a collection input even without wildcards', () => {
    const selection = graph({
      '/file/package-json': value(1),
      '/selection': derive({ files: many<number>('/file/package-json') }, ({ files }) => files),
    }).compile(['/selection'])['/selection']!

    assert.deepEqual(selection, { '/file/package-json': 1 })
  })

  it('unions multiple selectors without duplicates', () => {
    const selection = graph({
      '/file/package-json': value(1),
      '/file/generated/types': value(2),
      '/command/test': value(3),
      '/ignored': value(4),
      '/selection': derive(
        { bindings: many<number>('/file/*', '/file/**', '/command/**') },
        ({ bindings }) => bindings,
      ),
    }).compile(['/selection'])['/selection']!

    assert.deepEqual(selection, {
      '/file/package-json': 1,
      '/file/generated/types': 2,
      '/command/test': 3,
    })
  })

  it('returns a frozen empty record when many() has no matches', () => {
    const selection = graph({
      '/selection': derive({ bindings: many('/missing/**') }, ({ bindings }) => bindings),
    }).compile(['/selection'])['/selection']!

    assert.deepEqual(selection, {})
    assert.ok(Object.isFrozen(selection))
  })

  it('returns frozen many() records keyed by complete binding paths', () => {
    const selection = graph({
      '/command/test/vitest': value('vitest'),
      '/command/test/node': value('node --test'),
      '/selection': derive(
        { commands: many<string>('/command/test/**') },
        ({ commands }) => commands,
      ),
    }).compile(['/selection'])['/selection']!

    assert.deepEqual(Object.keys(selection), [
      '/command/test/vitest',
      '/command/test/node',
    ])
    assert.equal(selection['/command/test/vitest'], 'vitest')
    assert.ok(Object.isFrozen(selection))
    assert.throws(() => {
      ;(selection as Record<string, string>)['/command/test/vitest'] = 'changed'
    }, TypeError)
  })

  it('freezes the injected input object', () => {
    const result = graph({
      '/value': value(42),
      '/result': derive({ value: one<number>('/value') }, inputs => {
        assert.ok(Object.isFrozen(inputs))
        assert.throws(() => {
          ;(inputs as { value: number }).value = 0
        }, TypeError)
        return inputs.value
      }),
    }).compile(['/result'])

    assert.equal(result['/result'], 42)
  })

  it('compile roots resolve exact and collection inputs transitively', () => {
    let initialized = false
    const container = graph({
      '/shared/prefix': value('item:'),
      '/file/first': derive(
        { prefix: one<string>('/shared/prefix') },
        ({ prefix }) => `${prefix}first`,
      ),
      '/file/second': value('second'),
      '/ignored': derive({ missing: one('/missing') }, () => { initialized = true }),
      '/files': derive({ files: many<string>('/file/**') }, ({ files }) => files),
    }).compile(['/files'])

    assert.deepEqual(Object.keys(container), [
      '/shared/prefix',
      '/file/first',
      '/file/second',
      '/files',
    ])
    assert.equal(container['/files']!['/file/first'], 'item:first')
    assert.equal(initialized, false)
  })

  it('accepts glob selectors directly as compile roots', () => {
    const container = graph({
      '/shared': value('shared'),
      '/target/ci/build': derive(
        { shared: one<string>('/shared') },
        ({ shared }) => `${shared}:build`,
      ),
      '/target/ci/test': value('test'),
      '/target/publish/pack': value('pack'),
      '/ignored': value(false),
    }).compile(['/target/ci/*'])

    assert.deepEqual(Object.keys(container), ['/shared', '/target/ci/build', '/target/ci/test'])
  })

  it('returns an empty container for an unmatched glob root', () => {
    const container = graph({ '/value': value(1) }).compile(['/missing/**'])
    assert.deepEqual(Object.keys(container), [])
    assert.ok(Object.isFrozen(container))
  })

  it('rejects cycles involving many() inputs', () => {
    const dagr = graph({
      '/item/value': derive({ values: many('/item/**') }, ({ values }) => values),
    })

    assert.throws(
      () => dagr.compile(['/item/value']),
      /Circular input: \/item\/value -> \/item\/value/,
    )
  })

  it('merges with right-biased replacement semantics', () => {
    const first = graph({ '/name': value('first'), '/answer': value(42) })
    const second = graph({ '/name': value('second'), '/extra': value('kept') })
    const third = graph({ '/name': value('third') })

    const chained = first.merge(second, third).compile()
    assert.equal(chained['/name'], 'third')
    assert.equal(chained['/answer'], 42)
    assert.equal(chained['/extra'], 'kept')

    const standalone = merge(first, second, third).compile()
    assert.equal(standalone['/name'], 'third')
    assert.deepEqual([...merge().keys()], [])
    assert.deepEqual([...first.merge().keys()], ['/name', '/answer'])
    assert.throws(
      () => first.merge({} as never),
      /Can only merge another graph, got object at 0/,
    )
  })

  it('keeps insertion and replacement order deterministic', () => {
    const dagr = graph({
      '/file/first': value(1),
      '/file/second': value(2),
      '/selection': derive(
        { files: many<number>('/file/**') },
        ({ files }) => Object.keys(files),
      ),
    }).merge(graph({
      '/file/first': value(10),
      '/file/third': value(3),
    }))

    assert.deepEqual([...dagr.keys()], [
      '/file/first', '/file/second', '/selection', '/file/third',
    ])
    assert.deepEqual(dagr.compile(['/selection'])['/selection'], [
      '/file/first', '/file/second', '/file/third',
    ])
  })

  it('exposes immutable bindings through bindingOf', () => {
    const dagr = graph({
      '/answer': value(42),
      '/copy': derive({ answer: one<number>('/answer') }, ({ answer }) => answer),
    })
    const binding = dagr.bindingOf('/copy')
    assert.ok(binding)

    assert.deepEqual(Object.keys(binding), ['inputs', 'factory'])
    assert.deepEqual(Object.keys(binding.inputs), ['answer'])
    assert.ok(Object.isFrozen(binding))
    assert.ok(Object.isFrozen(binding.inputs))
    assert.ok(Object.isFrozen(binding.inputs.answer))
    assert.equal(dagr.bindingOf('/missing'), undefined)
  })

  it('accepts only the current binding signatures', () => {
    assert.throws(() => Reflect.apply(value, undefined, [1, {}]), /exactly one argument/)
    assert.throws(() => Reflect.apply(derive, undefined, [{}, () => 1, {}]), /exactly two arguments/)
    assert.throws(() => Reflect.apply(construct, undefined, [{}, class {}, {}]), /exactly two arguments/)
  })

  it('rejects missing exact bindings and exact cycles', () => {
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
    assert.throws(() => circular.compile(), /Circular input: \/a -> \/b -> \/a/)
  })

  it('composes promises synchronously as ordinary values', () => {
    const promise = Promise.resolve(42)
    const container = graph({
      '/promise': value(promise),
      '/injected': derive(
        { promise: one<Promise<number>>('/promise') },
        ({ promise: injected }) => injected,
      ),
    }).compile()

    assert.equal(container['/promise'], promise)
    assert.equal(container['/injected'], promise)
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
      value: (...args: unknown[]) => unknown
    }
    const dagr = rdk.graph({ '/answer': rdk.value(42) })
    assert.equal(dagr.compile()['/answer'], 42)
  })

  it('preserves native argument validation through the bridge', async () => {
    const rdk = (await sandboxRdk()).default as {
      one: (...args: unknown[]) => unknown
      value: (...args: unknown[]) => unknown
      derive: (...args: unknown[]) => unknown
      construct: (...args: unknown[]) => unknown
    }

    assert.throws(() => rdk.one('/a', '/b'), /exactly one argument/)
    assert.throws(() => rdk.value(1, 2), /exactly one argument/)
    assert.throws(() => rdk.derive({}, () => 1, {}), /exactly two arguments/)
    assert.throws(() => rdk.construct({}, class {}, {}), /exactly two arguments/)
  })

  it('passes input records to callbacks in the sandbox realm', async () => {
    const context = createSandboxContext()
    const builtins = createBuiltinModules(context)
    const consumer = new vm.SourceTextModule(`
      import rdk from 'dagr:rdk'

      const dagr = rdk.graph({
        '/file/example': rdk.value('example'),
        '/result': rdk.derive({ files: rdk.many('/file/**') }, inputs => (
          Object.getPrototypeOf(inputs) === Object.prototype
          && Object.getPrototypeOf(inputs.files) === Object.prototype
          && inputs.files['/file/example'] === 'example'
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