import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import rdk, { construct, derive, value } from '../rdk/dagr.rdk.js'

describe('rdk graph', () => {
  it('compiles every binding eagerly and once', () => {
    let initialized = 0
    class Greeter {
      greet(name) {
        return `hello ${name}`
      }
    }

    const container = rdk.graph({
      unused: derive([], () => ++initialized),
      name: value('caeus'),
      greeter: construct([], Greeter),
      greeting: derive(['name', 'greeter'], (name, greeter) => greeter.greet(name)),
    }).compile()

    assert.equal(initialized, 1)
    assert.equal(container.greeting, 'hello caeus')
    assert.equal(container.unused, 1)
  })

  it('shakes bindings before compilation', () => {
    let initialized = false
    const shaken = rdk.graph({
      unused: derive([], () => { initialized = true }),
      name: value('caeus'),
      greeting: derive(['name'], name => `hello ${name}`),
    }).shake(['greeting'])

    assert.deepEqual([...shaken.keys()], ['name', 'greeting'])
    assert.equal(shaken.compile().greeting, 'hello caeus')
    assert.equal(initialized, false)
  })

  it('merges with right-biased overrides', () => {
    const left = rdk.graph({ name: value('left'), answer: value(42) })
    const right = rdk.graph({ name: value('right') })
    const merged = left.merge(right)

    assert.equal(merged.compile().name, 'right')
    assert.equal(merged.compile().answer, 42)
  })

  it('merges graphs loaded through separate JavaScript module instances', async () => {
    const foreignRdk = (await import('../rdk/dagr.rdk.js?foreign-graph')).default
    const left = rdk.graph({ name: value('left') })
    const right = foreignRdk.graph({
      name: foreignRdk.value('right'),
      answer: foreignRdk.value(42),
    })

    const merged = left.merge(right).compile()

    assert.equal(merged.name, 'right')
    assert.equal(merged.answer, 42)
  })

  it('exposes immutable definitions', () => {
    const graph = rdk.graph({ answer: value(42) })
    const binding = graph.definitionOf('answer')

    assert.deepEqual(binding.deps, [])
    assert.deepEqual(binding.tags, [])
    assert.equal(binding.factory(), 42)
    assert.ok(Object.isFrozen(binding))
    assert.ok(Object.isFrozen(binding.deps))
    assert.ok(Object.isFrozen(binding.tags))
  })

  it('injects every tagged binding as a record', () => {
    const handler = Symbol('handler')
    const symbolic = Symbol('symbolic')
    const container = rdk.graph({
      first: value(1, [handler]),
      [symbolic]: value(2, new Set([handler])),
      ignored: value(3),
      handlers: derive([{ tag: handler }], handlers => handlers),
    }).compile()

    assert.deepEqual(Reflect.ownKeys(container.handlers), ['first', symbolic])
    assert.equal(container.handlers.first, 1)
    assert.equal(container.handlers[symbolic], 2)
    assert.ok(Object.isFrozen(container.handlers))
  })

  it('injects an empty record when no binding has the tag', () => {
    const container = rdk.graph({
      bindings: derive([{ tag: 'missing' }], bindings => bindings),
    }).compile()

    assert.deepEqual(container.bindings, {})
    assert.ok(Object.isFrozen(container.bindings))
  })

  it('preserves dependency positions when direct and tagged dependencies mix', () => {
    const prefix = Symbol('prefix')
    const container = rdk.graph({
      [prefix]: value('item:'),
      first: value(1, ['item']),
      result: derive(
        [prefix, { tag: 'item' }],
        (prefixValue, items) => `${prefixValue}${items.first}`,
      ),
    }).compile()

    assert.equal(container.result, 'item:1')
    assert.equal(container[prefix], 'item:')
  })

  it('shakes tagged bindings and their transitive dependencies', () => {
    const symbolic = Symbol('symbolic')
    const shaken = rdk.graph({
      prefix: value('item:'),
      first: derive(['prefix'], prefix => `${prefix}first`, ['item']),
      [symbolic]: value(2, ['item']),
      ignored: value(3),
      items: derive([{ tag: 'item' }], items => items),
    }).shake(['items'])

    assert.deepEqual([...shaken.keys()], ['prefix', 'first', 'items', symbolic])
    assert.equal(shaken.compile().items.first, 'item:first')
  })

  it('replaces tags when a binding is overridden', () => {
    const base = rdk.graph({
      value: value(1, ['item']),
      items: derive([{ tag: 'item' }], items => items),
    })
    const merged = base.merge(rdk.graph({ value: value(2) }))

    assert.deepEqual(merged.shake(['items']).compile().items, {})
  })

  it('rejects cycles introduced by tag dependencies', () => {
    const binding = Symbol('value')
    const graph = rdk.graph({
      [binding]: derive([{ tag: 'loop' }], values => values, ['loop']),
    })

    assert.throws(
      () => graph.compile(),
      /Circular dependency: Symbol\(value\) -> Symbol\(value\)/,
    )
  })

  it('copies tag and selector inputs at definition time', () => {
    const tag = Symbol('tag')
    const selector = { tag }
    const tags = [tag]
    const binding = derive([selector], values => values, tags)

    selector.tag = 'changed'
    tags[0] = 'changed'

    assert.deepEqual(binding.deps, [{ tag }])
    assert.deepEqual(binding.tags, [tag])
    assert.ok(Object.isFrozen(binding.deps[0]))
  })

  it('rejects missing bindings', () => {
    const graph = rdk.graph({ greeting: derive(['name'], name => `hello ${name}`) })
    assert.throws(() => graph.compile(), /Missing binding "name" required by "greeting"/)
  })

  it('rejects circular dependencies', () => {
    const graph = rdk.graph({
      a: derive(['b'], b => b),
      b: derive(['a'], a => a),
    })
    assert.throws(() => graph.compile(), /Circular dependency: a -> b -> a/)
  })

  it('composes promises synchronously as ordinary values', () => {
    const promise = Promise.resolve(42)
    const graph = rdk.graph({
      promise: value(promise),
      injected: derive(['promise'], value => value),
    })

    const container = graph.compile()
    assert.equal(container.promise, promise)
    assert.equal(container.injected, promise)
  })
})
