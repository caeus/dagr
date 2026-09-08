# Dagr recipes

`recipes/` contains independently consumable recipes used to calculate Dagr build configuration and targets.

## Recipes

| Recipe | Role |
| --- | --- |
| [`rdk`](rdk/) | Recipe Development Kit: a small synchronous DI DAG for composing calculations |
| [`typescript`](typescript/) | Composable TypeScript stack that calculates generated configuration and Dagr targets |

The TypeScript recipe uses the RDK as its calculation engine. Project facts and developer intent enter the graph;
semantic settings, generated files, targets, facets, and the final Dagr index are derived outputs.

## Boundaries

Each top-level recipe directory is independently mountable and publishable. Everything needed at runtime lives
inside that recipe directory. Repository-only tests live in [`tests/`](tests/).

Recipes expose `dagr.recipe.js`. Supporting recipes can expose another descriptive `dagr.*.js` entry point.

Consumers choose their own mount aliases. A mounted TypeScript recipe might therefore be imported as:

```js
import typescript from '//recipes/ts//dagr.recipe.js'
```

The alias is local to the consuming repository and is not part of the recipe identity.

## Publication

The repository builds immutable recipe filesystem images:

- `ghcr.io/caeus/dagr-rdk`
- `ghcr.io/caeus/dagr-ts-recipes`

Published images finish with `WORKDIR /recipe`, allowing Dagr to materialize the recipe contents directly.
Consumers should pin immutable tree-SHA versions for reproducible builds.

## Development

Run the recipe test suite with:

```sh
dagr run //recipes:ci:test
```

Build recipe images with:

```sh
dagr run //recipes:ci:image-rdk
dagr run //recipes:ci:image-typescript
```

For authoring conventions and the RDK calculation model, see the
[`dagr-recipes` Agent Skill](../.agents/skills/dagr-recipes/SKILL.md).
