# Dagr recipes

`recipes/` contains independently consumable recipes used to calculate Dagr build configuration and targets.

## Recipes

| Recipe | Role |
| --- | --- |
| [`rdk`](rdk/) | Recipe Development Kit: a small synchronous graph for composing calculations |
| [`typescript`](typescript/) | Composable TypeScript recipe that calculates generated configuration and Dagr targets |

The TypeScript recipe uses one RDK graph. It addresses facts, calculations, files, commands, requirements, and targets by absolute semantic binding paths. Derived bindings inject one named object: `one('/path')` resolves one exact binding and `many('/path/**')` resolves an open collection of matches.

## Boundaries

Each top-level recipe directory is independently mountable and publishable. Everything needed at runtime lives inside that recipe directory. Repository-only tests live in [`tests/`](tests/).

Build recipes expose `dagr.recipe.js`. The RDK exposes `dagr.rdk.js`.

A recipe is a builder over a reusable feature graph. Features merge through normal RDK composition; calling the recipe adds one package declaration and compiles its `/dagr/index` binding. No graph is copied per intent, and paths replace separate contribution or facet registries.

Consumers choose their own mount aliases. A mounted TypeScript recipe might therefore be imported as:

```js
import typescript from '//recipes/ts//dagr.recipe.js'
```

The alias is local to the consuming repository and is not part of the recipe identity.

## Publication

The repository builds immutable recipe filesystem images:

- `ghcr.io/caeus/dagr-rdk`
- `ghcr.io/caeus/dagr-ts-recipes`

Published images finish with `WORKDIR /recipe`, allowing Dagr to materialize the recipe contents directly. Consumers should pin immutable tree-SHA versions for reproducible builds.

## Development

Run the recipe test suite with:

```sh
dagr run //recipes:ci:test
```

That target's context is `recipes/` alone, which is what proves a recipe works without its consumers present. Tests that need a second package, the recipe plus an index that mounts it, run from the harness instead:

```sh
dagr run //harness:ci:test
```

Build recipe images with:

```sh
dagr run //recipes:ci:image-rdk
dagr run //recipes:ci:image-typescript
```

For authoring conventions and the RDK calculation model, see the [`dagr-recipes` Agent Skill](../.agents/skills/dagr-recipes/SKILL.md).
