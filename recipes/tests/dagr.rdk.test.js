import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadRdk } from './dagr.typescript-loader.js'

const { construct, default: rdk, derive, many, one, value } = await loadRdk()

describe('rdk graph', () => {
  it('injects named exact dependencies', () => {
    const container = rdk.graph({
      '/name': value('caeus'),
      '/greeting': derive({ name: one('/name') }, ({ name }) => `hello ${name}`),
    }).compile(['/greeting'])

    assert.equal(container['/name'], 'caeus')
    assert.equal(container['/greeting'], 'hello caeus')
  })

  it('constructs classes from one named dependency object', () => {
    class Greeter {
      constructor({ name }) {
        this.name = name
      }

      greet() {
        return `hello ${this.name}`
      }
    }

    const container = rdk.graph({
      '/name': value('caeus'),
      '/greeter': construct({ name: one('/name') }, Greeter),
    }).compile(['/greeter'])

    assert.equal(container['/greeter'].greet(), 'hello caeus')
  })

  it('compiles all bindings eagerly and once when roots are omitted', () => {
    let initialized = 0
    const graph = rdk.graph({
      '/value': derive({}, () => ++initialized),
      '/copy': derive({ value: one('/value') }, ({ value }) => value),
    })

    const container = graph.compile()
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
    ]) {
      assert.throws(() => rdk.graph({ [name]: value(1) }), message)
    }
    assert.throws(() => rdk.graph({ [Symbol('binding')]: value(1) }), /absolute semantic path/)
  })

  it('requires named dependency declarations to use one() or many()', () => {
    assert.throws(() => derive([], String), /dependencies must be an object/)
    assert.throws(() => derive(['/value'], String), /dependencies must be an object/)
    assert.throws(() => derive({ value: '/value' }, String), /one\(\) or many\(\)/)
    assert.throws(() => derive({ value: ['/value'] }, String), /one\(\) or many\(\)/)
    assert.throws(() => derive({ [Symbol('value')]: one('/value') }, String), /names must be strings/)
  })

  it('validates one() as an exact semantic path', () => {
    for (const dependency of ['relative', '/', '/trailing/', '/double//slash', '/dot/./x']) {
      assert.throws(() => one(dependency))
    }
    assert.throws(() => one('/file/**'), /reserved wildcards/)
    assert.throws(() => one('/file/*'), /reserved wildcards/)
    assert.throws(() => one('/a', '/b'), /exactly one argument/)
  })

  it('validates many() selectors and requires at least one', () => {
    assert.throws(() => many(), /at least one selector/)
    assert.throws(() => many('relative'), /must start with/)
    assert.throws(() => many('/file/**', { selector: '/command/**' }), /absolute semantic path/)
  })

  it('resolves * as exactly one path segment', () => {
    const files = rdk.graph({
      '/file/package-json': value(1),
      '/file/tsconfig': value(2),
      '/file/generated/types': value(3),
      '/files': value(4),
      '/selection': derive({ files: many('/file/*') }, ({ files }) => files),
    }).compile(['/selection'])['/selection']

    assert.deepEqual(files, {
      '/file/package-json': 1,
      '/file/tsconfig': 2,
    })
  })

  it('resolves ** across nested path segments', () => {
    const files = rdk.graph({
      '/file/package-json': value(1),
      '/file/generated/types': value(2),
      '/selection': derive({ files: many('/file/**') }, ({ files }) => files),
    }).compile(['/selection'])['/selection']

    assert.deepEqual(files, {
      '/file/package-json': 1,
      '/file/generated/types': 2,
    })
  })

  it('treats many() as a collection dependency even without wildcards', () => {
    const selection = rdk.graph({
      '/file/package-json': value(1),
      '/selection': derive({ files: many('/file/package-json') }, ({ files }) => files),
    }).compile(['/selection'])['/selection']

    assert.deepEqual(selection, { '/file/package-json': 1 })
  })

  it('unions multiple selectors in one many() dependency without duplicates', () => {
    const selection = rdk.graph({
      '/file/package-json': value(1),
      '/file/generated/types': value(2),
      '/command/test': value(3),
      '/ignored': value(4),
      '/selection': derive(
        { bindings: many('/file/*', '/file/**', '/command/**') },
        ({ bindings }) => bindings,
      ),
    }).compile(['/selection'])['/selection']

    assert.deepEqual(selection, {
      '/file/package-json': 1,
      '/file/generated/types': 2,
      '/command/test': 3,
    })
  })

  it('returns a frozen empty record when many() has no matches', () => {
    const selection = rdk.graph({
      '/selection': derive({ bindings: many('/missing/**') }, ({ bindings }) => bindings),
    }).compile(['/selection'])['/selection']

    assert.deepEqual(selection, {})
    assert.ok(Object.isFrozen(selection))
  })

  it('returns frozen many() records keyed by complete binding paths', () => {
    const selection = rdk.graph({
      '/command/test/vitest': value('vitest'),
      '/command/test/node': value('node --test'),
      '/selection': derive({ commands: many('/command/test/**') }, ({ commands }) => commands),
    }).compile(['/selection'])['/selection']

    assert.deepEqual(Object.keys(selection), [
      '/command/test/vitest',
      '/command/test/node',
    ])
    assert.equal(selection['/command/test/vitest'], 'vitest')
    assert.ok(Object.isFrozen(selection))
    assert.throws(() => { selection['/command/test/vitest'] = 'changed' }, TypeError)
  })

  it('injects exact and collection dependencies by name', () => {
    const container = rdk.graph({
      '/prefix': value('commands:'),
      '/command/build/typescript': value('tsc'),
      '/command/test/vitest': value('vitest'),
      '/result': derive(
        { prefix: one('/prefix'), commands: many('/command/**') },
        ({ prefix, commands }) => `${prefix}${Object.values(commands).join(',')}`,
      ),
    }).compile(['/result'])

    assert.equal(container['/result'], 'commands:tsc,vitest')
  })

  it('freezes the injected dependency object', () => {
    const result = rdk.graph({
      '/value': value(42),
      '/result': derive({ value: one('/value') }, dependencies => {
        assert.ok(Object.isFrozen(dependencies))
        assert.throws(() => { dependencies.value = 0 }, TypeError)
        return dependencies.value
      }),
    }).compile(['/result'])

    assert.equal(result['/result'], 42)
  })

  it('compile roots resolve exact and many dependencies transitively in one traversal', () => {
    let initialized = false
    const container = rdk.graph({
      '/shared/prefix': value('item:'),
      '/file/first': derive({ prefix: one('/shared/prefix') }, ({ prefix }) => `${prefix}first`),
      '/file/second': value('second'),
      '/ignored': derive({ missing: one('/missing') }, () => { initialized = true }),
      '/files': derive({ files: many('/file/**') }, ({ files }) => files),
    }).compile(['/files'])

    assert.deepEqual(Object.keys(container), [
      '/shared/prefix',
      '/file/first',
      '/file/second',
      '/files',
    ])
    assert.equal(container['/files']['/file/first'], 'item:first')
    assert.equal(initialized, false)
  })

  it('accepts glob selectors directly as compile roots', () => {
    const container = rdk.graph({
      '/shared': value('shared'),
      '/target/ci/build': derive({ shared: one('/shared') }, ({ shared }) => `${shared}:build`),
      '/target/ci/test': value('test'),
      '/target/publish/pack': value('pack'),
      '/ignored': value(false),
    }).compile(['/target/ci/*'])

    assert.deepEqual(Object.keys(container), ['/shared', '/target/ci/build', '/target/ci/test'])
  })

  it('returns an empty container for an unmatched glob root', () => {
    const container = rdk.graph({ '/value': value(1) }).compile(['/missing/**'])
    assert.deepEqual(Object.keys(container), [])
    assert.ok(Object.isFrozen(container))
  })

  it('rejects cycles involving many() dependencies', () => {
    const graph = rdk.graph({
      '/item/value': derive({ values: many('/item/**') }, ({ values }) => values),
    })

    assert.throws(
      () => graph.compile(['/item/value']),
      /Circular dependency: \/item\/value -> \/item\/value/,
    )
  })

  it('merges with right-biased replacement semantics', () => {
    const first = rdk.graph({ '/name': value('first'), '/answer': value(42) })
    const second = rdk.graph({ '/name': value('second'), '/extra': value('kept') })
    const third = rdk.graph({ '/name': value('third') })

    const chained = first.merge(second, third).compile()
    assert.equal(chained['/name'], 'third')
    assert.equal(chained['/answer'], 42)
    assert.equal(chained['/extra'], 'kept')

    const standalone = rdk.merge(first, second, third).compile()
    assert.equal(standalone['/name'], 'third')
    assert.deepEqual([...rdk.merge().keys()], [])
    assert.deepEqual([...first.merge().keys()], ['/name', '/answer'])
    assert.throws(
      () => rdk.merge(first, { keys: () => [][Symbol.iterator](), bindingOf: () => undefined }),
      /Can only merge another graph, got object at 1/,
    )
  })

  it('keeps insertion and replacement order deterministic', () => {
    const graph = rdk.graph({
      '/file/first': value(1),
      '/file/second': value(2),
      '/selection': derive({ files: many('/file/**') }, ({ files }) => Object.keys(files)),
    }).merge(rdk.graph({
      '/file/first': value(10),
      '/file/third': value(3),
    }))

    assert.deepEqual([...graph.keys()], [
      '/file/first', '/file/second', '/selection', '/file/third',
    ])
    assert.deepEqual(graph.compile(['/selection'])['/selection'], [
      '/file/first', '/file/second', '/file/third',
    ])
  })

  it('merges graphs loaded through separate JavaScript module instances', async () => {
    const foreignRdk = (await loadRdk()).default
    const left = rdk.graph({ '/name': value('left') })
    const right = foreignRdk.graph({
      '/name': foreignRdk.value('right'),
      '/answer': foreignRdk.value(42),
    })

    const merged = left.merge(right).compile()
    assert.equal(merged['/name'], 'right')
    assert.equal(merged['/answer'], 42)
  })

  it('normalizes dependency declarations across separate module instances', async () => {
    const foreignRdk = (await loadRdk()).default
    const graph = rdk.graph({
      '/name': value('caeus'),
      '/greeting': foreignRdk.derive(
        { name: foreignRdk.one('/name') },
        ({ name }) => `hello ${name}`,
      ),
    })

    assert.equal(graph.compile(['/greeting'])['/greeting'], 'hello caeus')
  })

  it('exposes immutable bindings through bindingOf', () => {
    const graph = rdk.graph({
      '/answer': value(42),
      '/copy': derive({ answer: one('/answer') }, ({ answer }) => answer),
    })
    const binding = graph.bindingOf('/copy')

    assert.deepEqual(Object.keys(binding), ['deps', 'factory'])
    assert.deepEqual(Object.keys(binding.deps), ['answer'])
    assert.ok(Object.isFrozen(binding))
    assert.ok(Object.isFrozen(binding.deps))
    assert.ok(Object.isFrozen(binding.deps.answer))
    assert.equal(graph.bindingOf('/missing'), undefined)
  })

  it('accepts only the current binding signatures', () => {
    assert.throws(() => value(1, {}), /exactly one argument/)
    assert.throws(() => derive({}, () => 1, {}), /exactly two arguments/)
    assert.throws(() => construct({}, class {}, {}), /exactly two arguments/)
  })

  it('rejects missing exact bindings and exact cycles', () => {
    const missing = rdk.graph({
      '/greeting': derive({ name: one('/name') }, ({ name }) => `hello ${name}`),
    })
    assert.throws(
      () => missing.compile(['/greeting']),
      /Missing binding "\/name" required by "\/greeting"/,
    )

    const circular = rdk.graph({
      '/a': derive({ b: one('/b') }, ({ b }) => b),
      '/b': derive({ a: one('/a') }, ({ a }) => a),
    })
    assert.throws(() => circular.compile(), /Circular dependency: \/a -> \/b -> \/a/)
  })

  it('composes promises synchronously as ordinary values', () => {
    const promise = Promise.resolve(42)
    const container = rdk.graph({
      '/promise': value(promise),
      '/injected': derive({ promise: one('/promise') }, ({ promise }) => promise),
    }).compile()

    assert.equal(container['/promise'], promise)
    assert.equal(container['/injected'], promise)
  })
})
