# Dagr recipe architecture

Use this reference when authoring, extending, reviewing, or debugging reusable recipes under
`recipes/`.

## Boundaries

Each top-level recipe directory is independently consumable. Runtime files stay inside that
directory; repository tests stay under `recipes/tests/`. Build recipes expose `dagr.recipe.js` and
may import Dagr's native libraries, including `dagr:rdk`, without mounting them.

## Composition

A repository defines a reusable composition once:

```js
export const nodeLibrary = recipe([
  typescript({ base, versions }),
  pnpm(),
  library(),
  vitest(),
])
```

Every feature is an RDK graph. Calling `nodeLibrary(declaration)` adds one package's irreducible facts
and compiles `/dagr/index`. `nodeLibrary.with(feature)` creates a new composition;
`nodeLibrary.graph` exposes the feature graph for inspection.

`recipe` is made with `builder(init, run, graph)`. A builder call runs
`run(graph.merge(init(...args)))`, so this pattern can be reused without adding another composition
system.

## Semantic binding paths

Recipe graphs use absolute semantic paths. A feature owns canonical facts, calculations, rendered
files, tooling, and executable commands under its own namespace. Examples include
`/typescript/package-json`, `/vitest/config`, `/vitest/tooling`, and `/vitest/tester`.

Singular capabilities stay in the semantic domain that owns the abstraction. TypeScript uses exact
paths such as `/typescript/compiler`, `/typescript/typechecker`, `/typescript/tester`, and
`/typescript/linter`; another language can own its corresponding paths independently in the same
graph. An implementation-owned command such as `/vitest/tester` may project into
`/typescript/tester`.

Cross-feature open integration is a separate adapter binding. `hoister()` consumes adapters ending in
`/hoisted`; package.json collects `/package-json/dependencies` and `/package-json/script`; tsconfig
collects `/tsconfig/types`; package managers collect `/package-manager/builds`. Producers opt into
these protocols without importing or registering with the consumer.

`/target/<facet>/<name>` remains the target ownership and Dagr index namespace.

Contribution helpers use the same named input model as RDK. Use `rdk.one('/path')` for one required
binding, `rdk.many('/path')` for optional exact injection, and wildcard selectors only for an open
aggregate.

```js
rdk.graph({
  '/source/directory': rdk.value('src'),
  '/health/report': file({ source: rdk.one('/source/directory') }, {
    for: ['test'],
    render: (_context, { source }) => render(source),
  }),
  '/health/tester': command({}, {
    for: ['test'],
    files: rdk.many('/health/report'),
    run,
  }),
  '/typescript/tester': adapter('/health/tester'),
  '/typescript/tester/package-json/script': adapter('/typescript/tester'),
  '/target/ci/test': target({
    tester: rdk.one('/typescript/tester'),
  }, { render: renderTarget }),
})
```

The helpers validate and, where appropriate, render binding values. `rdk.one()` requires one exact
binding. `rdk.many()` collects exact optional bindings or discovers an explicitly open aggregate.

## Output bindings

A file renderer receives `{ intent, facet, host }` plus one named input object and returns valid
Dagr steps. An empty array means "nothing to do"; `undefined`, `null`, and `false` are errors. Files
are context-aware because a tsconfig or manifest genuinely differs per intent.

A command renderer receives one named input object and returns invocations: `{ tool }` for an
installed binary or `{ shell }` for a literal command line. It gets no context and returns no step.
One command binding can become a container step, package.json script, or task in another runner.

`for` is the intent gate. A renderer that reads `context.intent` merely to suppress itself has the
wrong `for` value.

A target binding receives its inputs as one named object beside the context. Its target path supplies
the facet and name. Required singular capabilities use `one()`. Each capability owns the exact paths
of the canonical files it requires and exposes the resulting optional record as `files`; the target
materializes that record. Host-sensitive output stays inside the native target's `run` function.

An exact command capability may return multiple ordered invocations. Package-script projections
should depend on the capability path, not directly on its current implementation, so one merge
replacement changes every consumer of that capability.

The `/dagr/index` calculation selects `/target/**`, groups targets by the facet and name in their
paths, validates local target dependencies, and returns the Dagr index. A target creates a facet by
existing.

## Hoisting

`hoister()` owns `/target/dev/hoist`. It discovers structurally marked file contributions with
`rdk.many('/**/hoisted', '/**/hoisted/*')` and renders only those values using the `dev` intent and the
actual host context.

A producer opts in independently:

```js
const editorConfig = () => rdk.graph({
  '/editor/config': file({}, {
    for: ['dev'],
    render: () => write('/repo/.editor.json'),
  }),
  '/editor/config/hoisted': adapter('/editor/config'),
})
```

No producer imports, calls, or registers with `hoister()`. Adding or removing a marked graph node is
enough because the shared namespace is the integration protocol.

The hoist target copies local package tarballs but no source, renders the marked values into `/repo`,
and exports `/repo/` to the package directory. It does not install. A dependency tree resolved inside
an image is wrong for a host, so the host runs its own package-manager install afterwards.

Graph construction remains deterministic. Hoisting is calculated entirely from graph structure; do
not inspect the host filesystem, environment, or other ambient state to decide what should be
hoisted.

## Package managers

Manager selection is an explicit feature graph. A manager supplies exact `/package-manager/**`
functions, owns canonical `/package-manager/config`, and projects that config into
`/package-manager/config/hoisted`. A custom manager uses the same paths, not a registry. Normal
right-biased graph merging makes the last manager complete.

Local package dependencies are copied from sibling `ci:pack` targets. Install manifests may point
at copied tarballs; pack and publish manifests retain their external ranges.

## Publication

Published recipe images are immutable filesystem images ending at `WORKDIR /recipe`. Consumers own
their mount aliases. Recipe source must not assume a particular alias. Native libraries such as
`dagr:rdk` ship with Dagr itself rather than as recipe images.
