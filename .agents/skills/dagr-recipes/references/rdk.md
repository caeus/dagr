# How Dagr recipes use RDK

The RDK at `recipes/rdk/dagr.rdk.js` is the recipe's only calculation engine.

## Core model

An RDK graph is one flat `Map` of bindings addressed by absolute semantic paths. Paths provide
identity and hierarchy. Exact dependencies name one binding; glob dependencies select open sets.
There is no separate tag, registry, or selector system.

```js
const graph = rdk.graph({
  '/source/directory': rdk.value('src'),
  '/message/greeting': rdk.derive(['/source/directory'], source => `Hello from ${source}`),
})

graph.merge(other)
graph.bindingOf('/message/greeting')
graph.keys()
graph.compile(['/message/greeting'])['/message/greeting']
```

- `value(input)` provides a fact.
- `derive(deps, factory)` calculates from explicit dependencies.
- `construct(deps, Class)` constructs a class.
- `merge` is immutable and right-biased.
- `compile()` resolves all bindings.
- `compile(roots)` retains exact or glob roots and every transitive exact or glob dependency.

Binding names, exact dependencies, and selectors are absolute paths. Binding names cannot contain
wildcards. Selectors use whole `*` and `**` segments and delegate matching to `dagr:glob`.

## Recipe paths

Use semantic path namespaces consistently:

- `/file/**` for generated file or step contributions;
- `/command/**` for context-free command contributions;
- `/target/<facet>/<name>` for Dagr targets;
- `/requirement/*` for package and ambient-type requirements;
- `/requirement/build-scripts/**` for package-manager-neutral build-script facts;
- paths such as `/package/name`, `/source/directory`, and `/output/layout` for ordinary facts and
  calculations.

The `file`, `command`, `fact`, `target`, and `requirement` helpers validate or render their values.
They do not group them. Consumers discover open collections with path selectors. A `fact` carries
an intent list and an opaque value; `factsFor` filters, flattens, and deduplicates matching values.

A target automatically depends on `/file/**` and `/command/**`. The `/dagr/index` binding depends on
`/target/**` and derives each target's facet and name from `/target/<facet>/<name>`.

Files render before commands. Contributions of one kind are ordered by their numeric `order`, which
defaults to zero. Equal orders retain graph key order. Use explicit ordering only when step sequence
is behavior.

Tool requirement consumers depend on `/requirement/*`. A package name appears in a requirement while
its version comes from the single `/version/catalog` binding. Package-manager adapters depend on
fact namespaces such as `/requirement/build-scripts/**` directly.

## Determinism

Factories stay synchronous and deterministic. Do not build bindings around network access, ambient
environment state, mutable registries, or asynchronous resolution. Promises are ordinary values and
are not awaited by `compile()`.

Glob matches follow graph key order. A merge replacement keeps the existing key position, while a
new binding appends in merge order.
