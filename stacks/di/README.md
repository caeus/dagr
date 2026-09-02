# DI

A tiny synchronous dependency-injection graph for inline JavaScript composition.

```js
import di, { toClass, toFun, toValue } from '//stacks/di//dagr.di.js'

class Greeter {
  greet(name) { return `Hello, ${name}` }
}

const module0 = di.module({
  unused: toValue(42),
  name: toValue('caeus'),
  greeter: toClass([], Greeter),
  greeting: toFun(['name', 'greeter'], (name, greeter) => greeter.greet(name)),
})

const module1 = di.module({ name: toValue('caeus!') })
const module = module0.merge(module1)

module.definitionOf('name')
module.keys()

const container = module.shake(['greeting']).compile()
container.greeting
```

Providers can carry tags. A `{ tag }` dependency collects every matching binding into a frozen
record at that argument position:

```js
const handler = Symbol('handler')
const symbolicHandler = Symbol('symbolicHandler')

const module = di.module({
  json: toValue(input => JSON.parse(input), [handler]),
  [symbolicHandler]: toFun([], () => value => value, new Set([handler])),
  handlers: toFun([{ tag: handler }], handlers => handlers),
})

const handlers = module.shake(['handlers']).compile().handlers
handlers.json('{"ready":true}')
handlers[symbolicHandler]('text')
```

`toValue(value, tags)`, `toFun(deps, factory, tags)`, and `toClass(deps, Class, tags)` accept tags
as an array or set of property keys. Direct dependencies remain property keys. Tag selectors and
direct dependencies can be mixed in any order.

Tag collection is module-wide and unordered. No matches produce a frozen `{}`. `shake` retains
all matching bindings and their transitive dependencies. A provider depending on its own tag is a
cycle. Since `merge` replaces the complete definition, it replaces that binding's tags too.

Modules are immutable. `merge` is right-biased, like object spread: definitions in the argument
override definitions in the receiver. `shake` returns a new module containing the requested roots
and their transitive dependencies.

`compile()` takes no arguments and eagerly initializes every binding in the module exactly once.
Shake first when bindings should be excluded from initialization. Missing dependencies, circular
dependencies are rejected. Promises are ordinary values: compilation never awaits or unwraps them.
