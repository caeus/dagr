# Recipe Development Kit (RDK)

An RDK graph is a flat collection of bindings addressed by absolute semantic paths. Derived bindings declare named dependencies with `one()` and `many()`, and factories receive those dependencies as one object.

```js
import rdk, { construct, derive, many, one, value } from '//recipes/rdk//dagr.rdk.js'

class Greeter {
  constructor({ name }) {
    this.name = name
  }

  greet() { return `Hello, ${this.name}` }
}

const base = rdk.graph({
  '/unused': value(42),
  '/person/name': value('caeus'),
  '/service/greeter': construct({ name: one('/person/name') }, Greeter),
  '/message/greeting': derive(
    { greeter: one('/service/greeter') },
    ({ greeter }) => greeter.greet(),
  ),
})

const graph = base.merge(rdk.graph({ '/person/name': value('caeus!') }))
const values = graph.compile(['/message/greeting'])
values['/message/greeting']
```

The import path above uses an example consumer-owned mount alias. Consumers may mount the recipe elsewhere.

## Binding paths

Every binding name is an absolute semantic path:

- it starts with `/`;
- it is not `/`;
- it has no trailing `/` or empty `//` segment;
- it has no `.` or `..` segment;
- it contains neither `*` nor `**`, which are reserved for selectors.

Use the path for identity and hierarchy, such as `/target/ci/build`, `/command/test/vitest`, or `/file/package-json`.

## Dependencies

`one(path)` declares one required exact binding. Wildcards are not allowed:

```js
const greeting = derive(
  { name: one('/person/name') },
  ({ name }) => `Hello, ${name}`,
)
```

`many(...selectors)` declares one collection dependency containing every binding matched by any selector. The result is a frozen record keyed by complete binding paths:

```js
const summary = derive(
  {
    source: one('/source/directory'),
    files: many('/file/**', '/generated/*'),
  },
  ({ source, files }) => ({ source, files }),
)
```

For example, `many('/file/**')` may inject:

```js
{
  '/file/package-json': 'package.json',
  '/file/tsconfig': 'tsconfig.json',
}
```

`many()` is collection semantics, not wildcard detection. `many('/file/package-json')` still produces a record containing that matching binding. Multiple selectors are unioned in graph key order, overlapping selectors do not duplicate a binding, and no matches produce a frozen empty object.

`*` matches exactly one segment. `**` matches zero or more segments. Matching delegates to the engine's `dagr:glob` built-in and scans the graph's flat `Map` in key order.

The dependency object is frozen before it reaches the factory, so names are stable local aliases rather than positional conventions.

## Compilation

`compile()` eagerly resolves every binding once. `compile(roots)` resolves only the roots and their transitive dependencies. Compile roots can be exact paths or glob selector strings. Exact roots retain one binding; glob roots retain every match.

Missing `one()` bindings and cycles, including cycles introduced through `many()` selection, are errors. Compilation is synchronous; promises remain ordinary values.

## Composition and order

Graphs are immutable. `merge` is right-biased, like object spread: bindings in arguments replace bindings in the receiver, and later arguments replace earlier ones. Replacing a path preserves its existing key position; newly introduced paths append in merge order. That makes key scans and `many()` records deterministic without sorting or a secondary index.

`rdk.merge(...graphs)` performs the same fold starting from an empty graph. No arguments produce an empty graph.
