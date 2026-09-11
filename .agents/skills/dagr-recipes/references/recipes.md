# Dagr recipe architecture

Use this reference when authoring, extending, reviewing, or debugging reusable recipes under
`recipes/`.

## Boundaries

Each top-level recipe directory is independently consumable. Runtime files stay inside that
directory; repository tests stay under `recipes/tests/`. Build recipes expose `dagr.recipe.js`, and
the RDK exposes `dagr.rdk.js`.

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

Recipe graphs use absolute semantic paths. Ordinary facts and calculations include paths such as
`/package/name`, `/source/directory`, and `/output/layout`. Open output sets use:

- `/file/**` for contextual file or step renderers;
- `/command/**` for context-free invocations;
- `/target/<facet>/<name>` for target ownership and Dagr index structure;
- `/requirement/*` for tool packages and ambient types;
- `/requirement/build-scripts/**` for portable, intent-scoped build-script facts.

Contribution helpers use the same named dependency model as RDK. Use `rdk.one('/path')` for one
required binding and `rdk.many('/a/**', '/b/**')` for the union of one or more glob patterns.

```js
rdk.graph({
  '/source/directory': rdk.value('src'),
  '/file/health': file({ source: rdk.one('/source/directory') }, {
    for: ['test'],
    render: (_context, { source }) => render(source),
  }),
  '/command/test/health': command({}, { for: ['test'], run }),
  '/target/ci/test': target({}, { render: renderTarget }),
})
```

The helpers validate and, where appropriate, render binding values. The path namespace is the only
grouping mechanism. `fact` carries an intent list plus an opaque value; `factsFor` filters a selected
collection by intent, flattens its values, and removes duplicates. `rdk.many()` discovers open sets
without a feature or target registry.

## Output bindings

A file renderer receives `{ intent, facet, host }` plus one named dependency object and returns valid
Dagr steps. An empty array means "nothing to do"; `undefined`, `null`, and `false` are errors. Files
are context-aware because a tsconfig or manifest genuinely differs per intent.

A command renderer receives one named dependency object and returns invocations: `{ tool }` for an
installed binary or `{ shell }` for a literal command line. It gets no context and returns no step.
One command binding can become a container step, package.json script, or task in another runner.

`for` is the intent gate. A renderer that reads `context.intent` merely to suppress itself has the
wrong `for` value.

A target binding receives `/file/**` and `/command/**` internally. Its own declared dependencies are
passed as one named object beside the context. Its target path supplies the facet and name. The target
chooses its render context and materializes the contributions it needs. Host-sensitive output stays
inside the native target's `run` function.

Files render before commands. Bindings of one kind are ordered by numeric `order`, defaulting to
zero. Equal orders keep graph key order. Use explicit ordering only where sequence is behavior.

The `/dagr/index` calculation selects `/target/**`, groups targets by the facet and name in their
paths, validates local target dependencies, and returns the Dagr index. A target creates a facet by
existing.

## Host files

`hostDev()` owns `/target/dev/sync`, which puts the generated files on the host so an editor reads
what a container builds with. Do not add a second mechanism for this, and do not enumerate paths to
export: the target copies no source, so everything under `/repo` is recipe output and
`EXPORT: { '/repo/': './' }` is already exactly the generated set. A feature that starts generating a
file is synced with no list to update.

It does not install. A dependency tree resolved inside an image is wrong for a host, so a manifest is
written and the host runs its own install. Do not make a target export `node_modules`.

## Package managers

Manager selection is an explicit feature graph. A manager supplies `/package-manager/**` functions,
owns `/command/pack/package`, and owns `/file/package-manager`. A custom manager uses the same paths,
not an adapter passed to a registry. Normal right-biased graph merging makes the last manager
complete.

Local package dependencies are copied from sibling `ci:pack` targets. Install manifests may point
at copied tarballs; pack and publish manifests retain their external ranges.

## Publication

Published recipe images are immutable filesystem images ending at `WORKDIR /recipe`. Consumers own
their mount aliases. Recipe source must not assume a particular alias.