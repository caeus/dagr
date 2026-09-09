# Recipe Development Kit (RDK)

A tiny synchronous dependency graph for inline JavaScript composition and settings calculation. It is the low-level machinery used to author and compose Dagr recipes.

```js
import rdk, { construct, derive, value } from '//recipes/rdk//dagr.rdk.js'

class Greeter {
  greet(name) { return `Hello, ${name}` }
}

const graph0 = rdk.graph({
  unused: value(42),
  name: value('caeus'),
  greeter: construct([], Greeter),
  greeting: derive(['name', 'greeter'], (name, greeter) => greeter.greet(name)),
})

const graph1 = rdk.graph({ name: value('caeus!') })
const graph = graph0.merge(graph1)

// several at once, latest winning; rdk.merge starts from nothing
const combined = graph0.merge(graph1, graph2)
const assembled = rdk.merge(...graphs)

graph.definitionOf('name')
graph.keys()

const container = graph.shake(['greeting']).compile()
container.greeting
```

The import path above uses an example consumer-owned mount alias. Consumers may mount the recipe elsewhere.

Providers can carry tags. A `{ tag }` dependency collects every matching binding into a frozen record at that argument position:

```js
const handler = Symbol('handler')
const symbolicHandler = Symbol('symbolicHandler')

const graph = rdk.graph({
  json: value(input => JSON.parse(input), [handler]),
  [symbolicHandler]: derive([], () => value => value, new Set([handler])),
  handlers: derive([{ tag: handler }], handlers => handlers),
})

const handlers = graph.shake(['handlers']).compile().handlers
handlers.json('{"ready":true}')
handlers[symbolicHandler]('text')
```

`value(input, tags)`, `derive(deps, factory, tags)`, and `construct(deps, Class, tags)` accept tags as an array or set of property keys. Direct dependencies remain property keys. Tag selectors and direct dependencies can be mixed in any order.

Tag collection is graph-wide and unordered. No matches produce a frozen `{}`. `shake` retains all matching bindings and their transitive dependencies. A provider depending on its own tag is a cycle. Since `merge` replaces the complete definition, it replaces that binding's tags too.

Graphs are immutable. `merge` is right-biased, like object spread: definitions in the arguments override definitions in the receiver, and later arguments override earlier ones. `rdk.merge(...graphs)` is the same fold with no receiver, so no arguments produce an empty graph. `shake` returns a new graph containing the requested roots and their transitive dependencies.

`compile()` takes no arguments and eagerly initializes every binding in the graph exactly once. Shake first when bindings should be excluded from initialization. Missing and circular dependencies are rejected. Promises are ordinary values: compilation never awaits or unwraps them.
