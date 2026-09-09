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

Every entry is an RDK graph. Calling `nodeLibrary(declaration)` adds one package's irreducible facts
and compiles the index. `nodeLibrary.with(feature)` creates a new composition;
`nodeLibrary.graph` exposes the feature graph for inspection.

`recipe` is made with `builder(init, run, graph)`. A builder call runs
`run(graph.merge(init(...args)))`, so this pattern can be reused without adding another composition
system.

## Output contributions

Files, commands, and targets are tagged RDK contributions:

```js
rdk.graph({
  sourceDirectory: rdk.value('src'),
  config: file(['sourceDirectory'], { for: ['test'], render }),
  test: command([], { for: ['test'], render }),
  testTarget: target([], { name: 'test', facet: 'ci', intent: 'test', render }),
})
```

The contribution helpers attach `files`, `commands`, or `targets` automatically.

A **file** renderer receives `{ intent, facet, host }` plus its dependency values and returns any
valid Dagr step or arrays of steps. An empty array means "nothing to do"; `undefined`, `null`, and
`false` are errors. Files are the context-aware kind, because a tsconfig or a manifest genuinely
differs per intent.

A **command** renderer receives only its dependency values and returns invocations — `{ tool }` for
an installed binary, `{ shell }` for a literal command line. It gets no context and returns no step,
so one declaration materializes as a container step (`runSteps(invocations, exec)`), a package.json
script, or a task in some other runner. Do not put a step in a command; do not read the intent to
decide whether to emit one. Installation is not a contribution — a target emits `install(host)`.

`for` is the only intent gate. A renderer that reaches for `context.intent` to decide whether to emit
anything is declaring the wrong `for` — narrow `for` instead. Requirements are gated separately, so a
tool can be installed for `dev` without its command running there.

When several outputs need the same tool packages, ambient types, or build allowances, model that
once with an ordinary `requirement` node. Commands and file renderers depend on the same value; neither
output becomes the source of truth for the other. `packages` lists names only — versions live in one
catalog, never in a feature.

A target receives context methods for rendering all applicable files or commands, or both in order.
This keeps ordering and selection local to the target. Host-sensitive output is rendered inside the
native target's `run` function. A target that builds from its own sources should be contributed with
`sourceTarget(...)` instead of an open-coded body. A dependency on a sibling target is a plain
`"facet:target"` or bare `"target"` string, which `index` checks something actually owns.

Files render before commands. Contributions of one kind are ordered by their numeric `order`, which
defaults to zero. Use explicit ordering only when step sequence is behavior, such as installation
before invoking a tool.

The final index calculation only groups target contributions by facet and name. It rejects duplicate
names within one facet. A target creates a facet by existing; no facet declaration is required.

## Package managers

Manager selection is an explicit feature graph. A manager supplies ordinary command transforms and
contributes install/pack commands plus configuration files. A custom manager is the same graph shape,
not an adapter object passed to a registry.

Local package dependencies are copied from sibling `ci:pack` targets. Install manifests may point at
the copied tarballs; pack and publish manifests retain their external ranges.

## Publication

Published recipe images are immutable filesystem images ending at `WORKDIR /recipe`. Consumers own
their mount aliases. Recipe source must not assume a particular alias.
