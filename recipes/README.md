# Dagr recipes

`recipes/` contains independently consumable recipes used to calculate Dagr build configuration and targets.

## Recipes

| Recipe | Role |
| --- | --- |
| [`rdk`](rdk/) | Recipe Development Kit: a small synchronous graph for composing calculations |
| [`typescript`](typescript/) | Composable TypeScript recipe that calculates generated configuration and Dagr targets |

The TypeScript recipe uses one RDK graph. Project facts and shared calculations are ordinary bindings. Its output
contributions are files, commands, and targets whose renderers receive target context.

## Boundaries

Each top-level recipe directory is independently mountable and publishable. Everything needed at runtime lives
inside that recipe directory. Repository-only tests live in [`tests/`](tests/).

Build recipes expose `dagr.recipe.js`. The RDK exposes `dagr.rdk.js`.

A recipe is a builder over a reusable feature graph. Features merge through normal RDK composition; calling the
recipe adds one package declaration and returns its Dagr index. No graph is copied per intent, and facets need no
declaration or registry.

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
