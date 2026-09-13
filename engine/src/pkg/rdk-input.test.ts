import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { createBuiltinModules } from '#pkg/builtins.js'
import {
  derive,
  graph,
  input,
  many,
  one,
  value,
} from '#pkg/rdk.js'
import { createSandboxContext } from '#pkg/sandbox.js'

describe('RDK input()', () => {
  it('projects required exact keys and optional pattern matches into one named input', () => {
    const container = graph({
      '/typescript/compiler': value('tsc'),
      '/typescript/tsconfig': value('tsconfig.json'),
      '/vitest/tsconfig/types': value('vitest/globals'),
      '/node/tsconfig/types': value('node'),
      '/compiler': derive({
        compiler: input({
          keys: ['/typescript/compiler', '/typescript/tsconfig'],
          patterns: ['/**/tsconfig/types'],
        }, ({ keys, patterns }) => Object.freeze({
          command: keys['/typescript/compiler'],
          config: keys['/typescript/tsconfig'],
          types: Object.values(patterns),
        })),
      }, ({ compiler }) => compiler),
    }).compile(['/compiler'])

    assert.deepEqual(container['/compiler'], {
      command: 'tsc',
      config: 'tsconfig.json',
      types: ['vitest/globals', 'node'],
    })
    assert.deepEqual(Object.keys(container), [
      '/typescript/compiler',
      '/typescript/tsconfig',
      '/vitest/tsconfig/types',
      '/node/tsconfig/types',
      '/compiler',
    ])
  })

  it('requires every exact key while allowing unmatched patterns', () => {
    const optional = graph({
      '/value': value(1),
      '/result': derive({
        selected: input({
          keys: ['/value'],
          patterns: ['/missing/**'],
        }, ({ keys, patterns }) => ({ value: keys['/value'], patterns })),
      }, ({ selected }) => selected),
    }).compile(['/result'])['/result']!

    assert.equal(optional.value, 1)
    assert.deepEqual(optional.patterns, {})
    assert.ok(Object.isFrozen(optional.patterns))

    const missing = graph({
      '/result': derive({
        selected: input({ keys: ['/missing'], patterns: [] }, ({ keys }) => keys),
      }, ({ selected }) => selected),
    })

    assert.throws(
      () => missing.compile(['/result']),
      /Missing binding "\/missing" required by "\/result"/,
    )
  })

  it('validates exact keys, patterns, and the projection', () => {
    assert.throws(() => input({ keys: ['/items/*'] }, String), /reserved wildcards/)
    assert.throws(() => input({ patterns: ['relative'] }, String), /must start with/)
    assert.throws(() => input({ keys: '/value' } as never, String), /keys must be an array/)
    assert.throws(() => input({ patterns: '/**/value' } as never, String), /patterns must be an array/)
    assert.throws(() => input({}, undefined as never), /projection must be a function/)
    assert.throws(() => Reflect.apply(input, undefined, [{}, String, false]), /exactly two arguments/)
  })

  it('freezes projection inputs and preserves graph-key ordering for pattern unions', () => {
    const selected = graph({
      '/artifact/first': value(1),
      '/artifact/second': value(2),
      '/task/test': value(3),
      '/result': derive({
        selected: input({
          keys: ['/artifact/second'],
          patterns: ['/artifact/*', '/artifact/**', '/task/**'],
        }, resolved => {
          assert.ok(Object.isFrozen(resolved))
          assert.ok(Object.isFrozen(resolved.keys))
          assert.ok(Object.isFrozen(resolved.patterns))
          return Object.freeze({
            keys: Object.keys(resolved.keys),
            patterns: Object.keys(resolved.patterns),
          })
        }),
      }, ({ selected }) => selected),
    }).compile(['/result'])['/result']!

    assert.deepEqual(selected, {
      keys: ['/artifact/second'],
      patterns: ['/artifact/first', '/artifact/second', '/task/test'],
    })
  })

  it('participates in cycle detection through both keys and patterns', () => {
    const exactCycle = graph({
      '/a': derive({
        value: input({ keys: ['/b'] }, ({ keys }) => keys['/b']),
      }, ({ value }) => value),
      '/b': derive({ value: one('/a') }, ({ value }) => value),
    })
    assert.throws(() => exactCycle.compile(['/a']), /Circular input: \/a -> \/b -> \/a/)

    const patternCycle = graph({
      '/item/value': derive({
        values: input({ patterns: ['/item/**'] }, ({ patterns }) => patterns),
      }, ({ values }) => values),
    })
    assert.throws(
      () => patternCycle.compile(['/item/value']),
      /Circular input: \/item\/value -> \/item\/value/,
    )
  })

  it('keeps one() and many() behavior unchanged', () => {
    const required = one<number>('/required')
    const items = many<string>('/items/**')
    assert.deepEqual(required.keys, ['/required'])
    assert.deepEqual(required.patterns, [])
    assert.deepEqual(items.keys, [])
    assert.deepEqual(items.patterns, ['/items/**'])

    const result = graph({
      '/required': value(1),
      '/items/a': value('a'),
      '/items/b': value('b'),
      '/result': derive({
        required,
        items,
        optional: many('/missing/exact'),
      }, inputs => inputs),
    }).compile(['/result'])['/result']!

    assert.equal(result.required, 1)
    assert.deepEqual(result.items, { '/items/a': 'a', '/items/b': 'b' })
    assert.deepEqual(result.optional, {})
    assert.ok(Object.isFrozen(result.items))
    assert.ok(Object.isFrozen(result.optional))
  })

  it('passes the projection argument through the sandbox realm', async () => {
    const context = createSandboxContext()
    const builtins = createBuiltinModules(context)
    const consumer = new vm.SourceTextModule(`
      import rdk from 'dagr:rdk'

      const dagr = rdk.graph({
        '/required': rdk.value('required'),
        '/items/first': rdk.value(1),
        '/items/second': rdk.value(2),
        '/result': rdk.derive({
          selected: rdk.input({
            keys: ['/required'],
            patterns: ['/items/**'],
          }, resolved => ({
            sameRealm:
              Object.getPrototypeOf(resolved) === Object.prototype
              && Object.getPrototypeOf(resolved.keys) === Object.prototype
              && Object.getPrototypeOf(resolved.patterns) === Object.prototype,
            frozen:
              Object.isFrozen(resolved)
              && Object.isFrozen(resolved.keys)
              && Object.isFrozen(resolved.patterns),
            required: resolved.keys['/required'],
            items: Object.keys(resolved.patterns),
          })),
        }, ({ selected }) => selected),
      })

      export default dagr.compile(['/result'])['/result']
    `, { context })

    await consumer.link(specifier => {
      const builtin = builtins.get(specifier)
      assert.ok(builtin, `Unknown built-in ${specifier}`)
      return builtin
    })
    await consumer.evaluate()

    const result = (consumer.namespace as Record<string, unknown>)['default'] as Record<string, unknown>
    assert.equal(result['sameRealm'], true)
    assert.equal(result['frozen'], true)
    assert.equal(result['required'], 'required')
    assert.deepEqual([...(result['items'] as string[])], ['/items/first', '/items/second'])
  })
})
