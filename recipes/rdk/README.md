# Recipe Development Kit (RDK)

An RDK graph is a flat collection of bindings addressed by absolute semantic paths. Exact
dependencies reference one binding. Glob dependencies select open sets of bindings. Paths provide
both identity and hierarchy, so RDK has no separate tag or registry system.

```js
import rdk, { construct, derive, value } from '//recipes/rdk//dagr.rdk.js'

class Greeter {
  greet(name) { return `Hello, ${name}` }
}

const base = rdk.graph({
  '/unused': value(42),
  '/person/name': value('caeus'),
  '/service/greeter': construct([], Greeter),
  '/message/greeting': derive(
    ['/person/name', '/service/greeter'],
    (name, greeter) => greeter.greet(name),
  ),
})

const graph = base.merge(rdk.graph({ '/person/name': value('caeus!') }))

graph.bindingOf('/person/name')
graph.keys()

const values = graph.compile(['/message/greeting'])
values['/message/greeting']
```

The import path above uses an example consumer-owned mount alias. Consumers may mount the recipe
elsewhere.

## Binding paths

Every binding name is an absolute semantic path:

- it starts with `/`;
- it is not `/`;
- it has no trailing `/` or empty `//` segment;
- it has no `.` or `..` segment;
- it contains neither `*` nor `**`, which are reserved for selectors.

Use the path for identity and hierarchy, such as `/target/ci/build`, `/command/test/vitest`, or
`/file/package-json`. Do not encode namespaces by concatenating camelCase words.

## Dependencies and compilation

Dependency syntax is structural. A string is always an exact binding path. A nested array is always
one glob dependency, whose selectors are unioned into one frozen record and passed as one factory
argument:

```js
const graph = rdk.graph({
  '/file/package-json': value('package.json'),
  '/file/tsconfig': value('tsconfig.json'),
  '/source/directory': value('src'),
  '/summary': derive(
    ['/source/directory', ['/file/**', '/generated/*']],
    (source, files) => ({ source, files }),
  ),
})
```

An exact dependency resolves to its value. A glob dependency resolves to a frozen record keyed by
complete matching paths:

```js
{
  '/file/package-json': 'package.json',
  '/file/tsconfig': 'tsconfig.json',
}
```

The nested array is the discriminator, not the presence of a wildcard. For example,
`derive([['/file/package-json']], files => files)` receives `{ '/file/package-json': value }`, while
`derive(['/file/package-json'], value => value)` receives the value directly. A scalar dependency may
not contain reserved wildcards. A glob dependency must contain at least one selector.

`*` matches exactly one segment. `**` matches zero or more segments. Multiple selectors in one glob
dependency are unioned in graph key order; overlapping selectors do not duplicate a binding. No
matches produce a frozen empty object. Matching delegates to the engine's `dagr:glob` built-in and
scans the graph's flat `Map` in key order.

`compile()` eagerly resolves every binding once. `compile(roots)` resolves only the roots and their
transitive dependencies. Compile roots are a separate API and can still be exact paths or glob
selector strings. Exact roots retain one binding; glob roots retain every match. Glob dependencies
retain every match transitively too. Missing exact bindings and cycles, including cycles introduced
through glob selection, are errors. Compilation is synchronous; promises remain ordinary values.

## Composition and order

Graphs are immutable. `merge` is right-biased, like object spread: bindings in arguments replace
bindings in the receiver, and later arguments replace earlier ones. Replacing a path preserves its
existing key position; newly introduced paths append in merge order. That makes key scans and glob
records deterministic without sorting or a secondary index.

`rdk.merge(...graphs)` performs the same fold starting from an empty graph. No arguments produce an
empty graph.
