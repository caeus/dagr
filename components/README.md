# Dagr reusable components

`components/` contains independently consumable pieces used to calculate Dagr build configuration and targets.
Not every component is a stack.

## Components

| Component | Role |
| --- | --- |
| [`di`](di/) | Small synchronous dependency-injection DAG used for settings calculation |
| [`typescript`](typescript/) | Composable TypeScript stack that calculates generated configuration and Dagr targets |

The TypeScript component uses DI as its calculation engine. Project facts and developer intent enter the graph;
semantic settings, generated files, targets, facets, and the final Dagr index are derived outputs.

## Boundaries

Each top-level component directory is independently mountable and publishable. Everything needed at runtime lives
inside that component directory. Repository-only tests live in [`tests/`](tests/).

A stack exposes `dagr.stack.js`. Supporting components can expose another descriptive `dagr.*.js` entry point.

Consumers choose their own mount aliases. A mounted TypeScript stack might therefore be imported as:

```js
import typescript from '//components/ts//dagr.stack.js'
```

The alias is local to the consuming repository and is not part of the component identity.

## Publication

The repository builds immutable component filesystem images:

- `ghcr.io/caeus/dagr-components-di`
- `ghcr.io/caeus/dagr-components-typescript`

Published images finish with `WORKDIR /component`, allowing Dagr to materialize the component contents directly.
Consumers should pin immutable tree-SHA versions for reproducible builds.

## Development

Run the component test suite with:

```sh
dagr run //components:ci:test
```

Build component images with:

```sh
dagr run //components:ci:image-di
dagr run //components:ci:image-typescript
```

For authoring conventions and the DI calculation model, see the
[`dagr-components` Agent Skill](../.agents/skills/dagr-components/SKILL.md).
