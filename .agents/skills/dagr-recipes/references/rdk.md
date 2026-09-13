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
- `input({ keys, patterns }, project)` declares required exact dependencies and optional plural pattern dependencies, then projects their resolved values.
- `one(path)` is the convenience form for one required exact input.
- `many(...patterns)` is the convenience form for the existing optional path-keyed collection input.
- `derive(inputs, factory)` calculates from the named input object.
- `construct(inputs, Class)` constructs a class with the named input object.
- `merge` is immutable and right-biased.
- `compile()` resolves all bindings.
- `compile(roots)` retains exact or glob roots and every transitive input.

## Inputs

`input()` is the fundamental graph-input abstraction. `keys` and `patterns` are semantic-path dependencies with different cardinality:

```js
rdk.derive({
  compiler: rdk.input({
    keys: [
      '/typescript/compiler',
      '/typescript/tsconfig',
    ],
    patterns: [
      '/**/tsconfig/types',
    ],
  }, ({ keys, patterns }) => Object.freeze({
    command: keys['/typescript/compiler'],
    config: keys['/typescript/tsconfig'],
    types: Object.values(patterns),
  })),
}, ({ compiler }) => ...)
```

Every entry in `keys` is exact, required, and one-to-one. Wildcards are rejected. Compilation fails if any exact key has no binding. The projector receives a frozen `keys` record keyed by the declared complete semantic paths.

Every entry in `patterns` is optional and zero-to-many. A pattern may match no bindings. Literal paths are valid patterns too, so a pattern can intentionally match zero or one binding. All matches across all patterns are unioned without duplicates and restored to deterministic graph-key order. The projector receives them as a frozen path-keyed `patterns` record.

The outer projector argument and both records are frozen. The projector itself may return any value; that return value is what the corresponding named input exposes to `derive()` or `construct()`. Exact keys and pattern matches all participate normally in traversal, cycle detection, and compile-root transitive retention before projection runs.

Use names that describe the input's role in the factory rather than repeating its full graph path:

```js
rdk.derive({
  source: rdk.one('/source/directory'),
  compiler: rdk.one('/typescript/compiler'),
  config: rdk.one('/vitest/config'),
}, ({ source, compiler, config }) => ...)
```

`one()` only accepts an exact absolute semantic path and rejects wildcards. It is an `input()` with one required key whose projector returns that key's value. Use it for every singular dependency. Keep replaceable capabilities in the semantic domain that owns them, such as `/typescript/compiler`, `/typescript/tester`, `/typescript/linter`, `/typescript/documenter`, and `/typescript/bundler`. Graph merging supplies the concrete binding. A Python feature can independently own `/python/compiler` or `/python/tester` in the same graph. Do not discover a collection and then rank, filter, or choose one member.

`many()` accepts one or more patterns and is an `input()` whose projector returns the frozen `patterns` record unchanged. It therefore preserves its collection semantics even when a pattern contains no wildcard. `many('/typescript/package-json')` is an optional exact injection: it returns an empty record or one entry. Multiple exact paths collect a known optional set. Use wildcard patterns only when any number of independent producers may participate in an actual aggregate.

Wildcard aggregates should name what their consumer collects, such as package.json dependencies or scripts, tsconfig types, ESLint rules, Makefile entries, or Turborepo tasks. They are not generic categories for every value of the same implementation type.

## Recipe paths and adapters

Canonical bindings live with the feature that owns their meaning:

- `/typescript/package-json` and `/typescript/tsconfig` are canonical rendered files;
- `/vitest/tester` and `/eslint/linter` are implementation-owned executable commands;
- `/typescript/tester` and `/typescript/linter` are replaceable TypeScript capabilities;
- `/vitest/tooling` and `/eslint/tooling` are canonical installation facts;
- `/target/<facet>/<name>` is the executable, user-addressable Dagr surface;
- `/package/name`, `/source/directory`, and `/output/layout` are ordinary shared facts and calculations.

Integration uses an additional binding that depends exactly on the canonical value. `adapter(path)` creates that identity projection. Current open protocols are:

- `/**/hoisted` and `/**/hoisted/*` for files exported to the host;
- `/**/package-json/dependencies` for package dependencies;
- `/**/package-json/script` for the open set of package scripts;
- `/**/tsconfig/types` for ambient TypeScript types;
- `/**/package-manager/builds` for dependency build allowances.

Language-scoped capability paths are exact bindings resolved with `one()`, not globbing. Right-biased merge replacement selects the implementation. Package-script projections depend on the capability path itself, so replacing `/typescript/compiler` also changes the `build` script without a second override.

Put each dependency at its semantic cause-site. `/typescript/compiler` names `/typescript/tsconfig`; `/eslint/linter` names `/eslint/config`. Command capabilities carry those exact optional file sets to targets. File rendering does not use a wildcard collection protocol.

The `file`, `command`, `target`, and `tooling` helpers validate or render values; paths carry identity and protocol participation. Files and invocations have numeric `order`, defaulting to zero. Equal orders retain graph-key order. Use ordering only inside a genuinely plural value or protocol.

## Determinism

Factories and input projectors stay synchronous and deterministic. Do not build bindings around network access, ambient environment state, mutable registries, or asynchronous resolution. Promises are ordinary values and are not awaited by `compile()`.

Pattern matches follow graph key order. A merge replacement keeps the existing key position, while a new binding appends in merge order. Compilation lazily derives a segment index when it first resolves a pattern; literal segments narrow candidates before the unchanged `dagr:glob` matcher runs. Patterns with no literal segments may still scan every key.
