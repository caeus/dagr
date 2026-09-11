# Dagr recipes

`recipes/` contains independently consumable recipes used to calculate Dagr build configuration and targets.

## Recipes

| Recipe | Role |
| --- | --- |
| [`typescript`](typescript/) | Composable TypeScript recipe that calculates generated configuration and Dagr targets |

The TypeScript recipe uses the engine-native `dagr:rdk` library. It addresses facts, calculations,
files, commands, requirements, and targets by absolute semantic binding paths. Derived bindings
inject one named object: `rdk.one('/path')` resolves one exact binding and
`rdk.many('/path/**')` resolves an open collection of matches.

## Boundaries

Each top-level recipe directory is independently mountable and publishable. Everything needed at
runtime lives inside that recipe directory except Dagr's native libraries, including `dagr:rdk`.
Repository-only tests live in [`tests/`](tests/).

Build recipes expose `dagr.recipe.js`. RDK is imported directly from `dagr:rdk`; it is not a
separately mounted recipe.

A recipe is a builder over a reusable feature graph. Features merge through normal RDK composition;
calling the recipe adds one package declaration and compiles its `/dagr/index` binding. No graph is
copied per intent, and paths replace separate contribution or facet registries.

Consumers choose their own mount aliases. A mounted TypeScript recipe might therefore be imported as:

```js
import typescript from '//recipes/ts//dagr.recipe.js'
```

The alias is local to the consuming repository and is not part of the recipe identity.

## Publication

The repository builds the immutable TypeScript recipe filesystem image:

- `ghcr.io/caeus/dagr-ts-recipes`

Published images finish with `WORKDIR /recipe`, allowing Dagr to materialize the recipe contents
directly. Consumers should pin immutable tree-SHA versions for reproducible builds.

## Development

Run the recipe test suite with:

```sh
dagr run //recipes:ci:test
```

That target's context is `recipes/` alone, which proves the recipe works without its consumers
present. Its test harness provides a local stand-in for native libraries where needed. Tests that
need a second package, the recipe plus an index that mounts it, run from the harness instead:

```sh
dagr run //harness:ci:test
```

Build the recipe image with:

```sh
dagr run //recipes:ci:image-typescript
```

For authoring conventions and the RDK calculation model, see the
[`dagr-recipes` Agent Skill](../.agents/skills/dagr-recipes/SKILL.md).
