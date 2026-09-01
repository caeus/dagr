import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import di, { toClass, toFun, toValue } from '../di/dagr.di.js'

describe('di', () => {
  it('compiles every binding eagerly and once', () => {
    let initialized = 0
    class Greeter {
      greet(name) {
        return `hello ${name}`
      }
    }

    const container = di.module({
      unused: toFun([], () => ++initialized),
      name: toValue('caeus'),
      greeter: toClass([], Greeter),
      greeting: toFun(['name', 'greeter'], (name, greeter) => greeter.greet(name)),
    }).compile()

    assert.equal(initialized, 1)
    assert.equal(container.greeting, 'hello caeus')
    assert.equal(container.unused, 1)
  })

  it('shakes bindings before compilation', () => {
    let initialized = false
    const shaken = di.module({
      unused: toFun([], () => { initialized = true }),
      name: toValue('caeus'),
      greeting: toFun(['name'], name => `hello ${name}`),
    }).shake(['greeting'])

    assert.deepEqual([...shaken.keys()], ['name', 'greeting'])
    assert.equal(shaken.compile().greeting, 'hello caeus')
    assert.equal(initialized, false)
  })

  it('merges with right-biased overrides', () => {
    const left = di.module({ name: toValue('left'), answer: toValue(42) })
    const right = di.module({ name: toValue('right') })
    const merged = left.merge(right)

    assert.equal(merged.compile().name, 'right')
    assert.equal(merged.compile().answer, 42)
  })

  it('merges modules loaded through separate JavaScript module instances', async () => {
    const foreignDi = (await import('../di/dagr.di.js?foreign-module')).default
    const left = di.module({ name: toValue('left') })
    const right = foreignDi.module({
      name: foreignDi.toValue('right'),
      answer: foreignDi.toValue(42),
    })

    const merged = left.merge(right).compile()

    assert.equal(merged.name, 'right')
    assert.equal(merged.answer, 42)
  })

  it('exposes immutable definitions', () => {
    const module = di.module({ answer: toValue(42) })
    const binding = module.definitionOf('answer')

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
    const container = di.module({
      first: toValue(1, [handler]),
      [symbolic]: toValue(2, new Set([handler])),
      ignored: toValue(3),
      handlers: toFun([{ tag: handler }], handlers => handlers),
    }).compile()

    assert.deepEqual(Reflect.ownKeys(container.handlers), ['first', symbolic])
    assert.equal(container.handlers.first, 1)
    assert.equal(container.handlers[symbolic], 2)
    assert.ok(Object.isFrozen(container.handlers))
  })

  it('injects an empty record when no binding has the tag', () => {
    const container = di.module({
      bindings: toFun([{ tag: 'missing' }], bindings => bindings),
    }).compile()

    assert.deepEqual(container.bindings, {})
    assert.ok(Object.isFrozen(container.bindings))
  })

  it('preserves dependency positions when direct and tagged dependencies mix', () => {
    const prefix = Symbol('prefix')
    const container = di.module({
      [prefix]: toValue('item:'),
      first: toValue(1, ['item']),
      result: toFun(
        [prefix, { tag: 'item' }],
        (prefixValue, items) => `${prefixValue}${items.first}`,
      ),
    }).compile()

    assert.equal(container.result, 'item:1')
    assert.equal(container[prefix], 'item:')
  })

  it('shakes tagged bindings and their transitive dependencies', () => {
    const symbolic = Symbol('symbolic')
    const shaken = di.module({
      prefix: toValue('item:'),
      first: toFun(['prefix'], prefix => `${prefix}first`, ['item']),
      [symbolic]: toValue(2, ['item']),
      ignored: toValue(3),
      items: toFun([{ tag: 'item' }], items => items),
    }).shake(['items'])

    assert.deepEqual([...shaken.keys()], ['prefix', 'first', 'items', symbolic])
    assert.equal(shaken.compile().items.first, 'item:first')
  })

  it('replaces tags when a binding is overridden', () => {
    const base = di.module({
      value: toValue(1, ['item']),
      items: toFun([{ tag: 'item' }], items => items),
    })
    const merged = base.merge(di.module({ value: toValue(2) }))

    assert.deepEqual(merged.shake(['items']).compile().items, {})
  })

  it('rejects cycles introduced by tag dependencies', () => {
    const value = Symbol('value')
    const module = di.module({
      [value]: toFun([{ tag: 'loop' }], values => values, ['loop']),
    })

    assert.throws(
      () => module.compile(),
      /Circular dependency: Symbol\(value\) -> Symbol\(value\)/,
    )
  })

  it('copies tag and selector inputs at definition time', () => {
    const tag = Symbol('tag')
    const selector = { tag }
    const tags = [tag]
    const binding = toFun([selector], values => values, tags)

    selector.tag = 'changed'
    tags[0] = 'changed'

    assert.deepEqual(binding.deps, [{ tag }])
    assert.deepEqual(binding.tags, [tag])
    assert.ok(Object.isFrozen(binding.deps[0]))
  })

  it('rejects missing bindings', () => {
    const module = di.module({ greeting: toFun(['name'], name => `hello ${name}`) })
    assert.throws(() => module.compile(), /Missing binding "name" required by "greeting"/)
  })

  it('rejects circular dependencies', () => {
    const module = di.module({
      a: toFun(['b'], b => b),
      b: toFun(['a'], a => a),
    })
    assert.throws(() => module.compile(), /Circular dependency: a -> b -> a/)
  })

  it('composes promises synchronously as ordinary values', () => {
    const promise = Promise.resolve(42)
    const module = di.module({
      promise: toValue(promise),
      injected: toFun(['promise'], value => value),
    })

    const container = module.compile()
    assert.equal(container.promise, promise)
    assert.equal(container.injected, promise)
  })
})
