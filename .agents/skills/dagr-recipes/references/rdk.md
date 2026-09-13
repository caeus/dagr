# How Dagr recipes use RDK

`dagr:rdk` is Dagr's native calculation library for recipe composition.

```js
import rdk from 'dagr:rdk'
```

## Core model

An RDK graph is one flat `Map` of bindings addressed by absolute semantic paths. Paths provide identity and hierarchy. Derived bindings declare named inputs and receive one frozen input object.

```js
const graph = rdk.graph({
  '/source/directory': rdk.value('src'),
  '/message/greeting': rdk.derive(
    { source: rdk.one('/source/directory') },
    ({ source }) => `Hello from ${source}`,
  ),
})

graph.merge(other)
graph.bindingOf('/message/greeting')
graph.keys()
graph.compile(['/message/greeting'])['/message/greeting']
```

- `value(input)` provides a fact.
- `one(path)` declares one required exact input.
- `many(...selectors)` declares one collection input containing every match.
- `derive(inputs, factory)` calculates from the named input object.
- `construct(inputs, Class)` constructs a class with the named input object.
- `merge` is immutable and right-biased.
- `compile()` resolves all bindings.
- `compile(roots)` retains exact or glob roots and every transitive input.

Use names that describe the input's role in the factory rather than repeating its full graph path:

```js
rdk.derive({
  source: rdk.one('/source/directory'),
  compiler: rdk.one('/compiler'),
  config: rdk.one('/vitest/config'),
}, ({ source, compiler, config }) => ...)
```

`one()` only accepts an exact absolute semantic path and rejects wildcards. Use it for every singular
dependency, including replaceable capabilities such as `/compiler`, `/tester`, `/linter`,
`/documenter`, and `/bundler`. Graph merging supplies the concrete binding. Do not discover a
collection and then rank, filter, or choose one member.

`many()` accepts one or more selectors and always produces a frozen record keyed by complete binding
paths. Collection semantics come from `many()`, not wildcard presence, so
`many('/typescript/package-json')` still returns a record. Use it only when any number of independent
features may participate.

Multiple selectors in one `many()` are unioned in graph key order. Overlapping selectors do not duplicate bindings. No matches produce a frozen empty record. Glob selectors use `*` and `**` and delegate matching to `dagr:glob`.

## Recipe paths and adapters

Canonical bindings live with the feature that owns their meaning:

- `/typescript/package-json` and `/typescript/tsconfig` are canonical rendered files;
- `/vitest/tester` and `/eslint/linter` are canonical executable capabilities;
- `/vitest/tooling` and `/eslint/tooling` are canonical installation facts;
- `/target/<facet>/<name>` is the executable, user-addressable Dagr surface;
- `/package/name`, `/source/directory`, and `/output/layout` are ordinary shared facts and calculations.

Integration uses an additional binding that depends exactly on the canonical value. `adapter(path)`
creates that identity projection. Current open protocols are:

- `/**/hoisted` and `/**/hoisted/*` for files exported to the host;
- `/**/package-json/script` for the open set of package scripts;
- `/**/tooling/for/typescript` and `/**/tooling/for/package-manager` for explicit tooling consumers.

Exact shared capability paths such as `/compiler` are adapters too, but they are resolved with
`one()`, not globbing. Right-biased merge replacement selects the concrete implementation.
Targets likewise depend exactly on the canonical files they render. File rendering does not use an
open collection protocol.

The `file`, `command`, `target`, and `tooling` helpers validate or render values; paths carry identity
and protocol participation. Files and invocations have numeric `order`, defaulting to zero. Equal
orders retain graph-key order. Use ordering only inside a genuinely plural value or protocol.

## Determinism

Factories stay synchronous and deterministic. Do not build bindings around network access, ambient environment state, mutable registries, or asynchronous resolution. Promises are ordinary values and are not awaited by `compile()`.

`many()` matches follow graph key order. A merge replacement keeps the existing key position, while
a new binding appends in merge order. Compilation lazily derives a segment index when it first
resolves a selector; literal segments narrow candidates before the unchanged `dagr:glob` matcher
runs. Patterns with no literal segments may still scan every key.
