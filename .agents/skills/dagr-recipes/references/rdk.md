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
  files: rdk.many('/file/**'),
  contributions: rdk.many('/command/**', '/generated/**'),
}, ({ source, files, contributions }) => ...)
```

`one()` only accepts an exact absolute semantic path and rejects wildcards. `many()` accepts one or more selectors and always produces a frozen record keyed by complete binding paths. Collection semantics come from `many()`, not wildcard presence, so `many('/file/package-json')` still returns a record.

Multiple selectors in one `many()` are unioned in graph key order. Overlapping selectors do not duplicate bindings. No matches produce a frozen empty record. Glob selectors use `*` and `**` and delegate matching to `dagr:glob`.

## Recipe paths

Use semantic path namespaces consistently:

- `/file/**` for generated file or step contributions;
- `/command/**` for context-free command contributions;
- `/target/<facet>/<name>` for Dagr targets;
- `/requirement/*` for package and ambient-type requirements;
- `/requirement/build-scripts/**` for package-manager-neutral build-script facts;
- paths such as `/package/name`, `/source/directory`, and `/output/layout` for ordinary facts and calculations.

The `file`, `command`, `fact`, `target`, and `requirement` helpers validate or render their values. They do not group them. Consumers discover open collections through `many()` selectors.

Files render before commands. Contributions of one kind are ordered by their numeric `order`, which defaults to zero. Equal orders retain graph key order. Use explicit ordering only when step sequence is behavior.

## Determinism

Factories stay synchronous and deterministic. Do not build bindings around network access, ambient environment state, mutable registries, or asynchronous resolution. Promises are ordinary values and are not awaited by `compile()`.

`many()` matches follow graph key order. A merge replacement keeps the existing key position, while a new binding appends in merge order.
