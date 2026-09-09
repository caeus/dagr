---
name: dagr-recipes
description: Work with Dagr reusable recipes and RDK contributions under recipes/. Use when modifying the TypeScript recipe, package-manager behavior, generated files, commands, targets, mounts, publication, or the inline Recipe Development Kit.
---

# Dagr recipes

Use this skill for reusable recipes under `recipes/`, especially the TypeScript recipe and its
synchronous RDK graph.

## First orient yourself

1. Read `recipes/README.md` and the nearest recipe `README.md`.
2. Classify each value as an irreducible fact, an ordinary calculation, or a rendered output.
3. Inspect the current dependency path before adding a binding.
4. Read the relevant reference:
   - [Recipe architecture](references/recipes.md)
   - [How recipes use RDK](references/rdk.md)

## Core model

A TypeScript recipe contains one immutable RDK graph. Facts and reusable calculations are ordinary
bindings. Files, commands, and targets are definitions created by `file`, `command`, and `target`;
the helpers attach their own collection tags.

`recipe(features)` returns a builder. Applying one package declaration merges its facts and runs:

```js
graph.shake(['index']).compile().index
```

The index collects target contributions, groups them by facet, rejects duplicate names within a
facet, and returns the result. There is no facet registry.

## Modeling rules

- Keep declarations limited to `location`, `version`, dependencies, and metadata.
- Keep shared semantics as ordinary RDK nodes.
- Use ordinary `requirement` nodes when files and commands must agree on tool packages, ambient
  types, or allowed dependency builds.
- Render generated files and executable commands only as contributions.
- Pass `intent`, `facet`, and `host` through render context; never make all graph values contextual.
- Let targets select their context and explicitly render the contributions they need.
- Keep target values native Dagr `{ name, deps, run }` objects.
- Do not add graph copies, registries, installer/builder/projector layers, or another evaluator.
- Make ownership collisions visible. Never depend on contribution order.
- Keep factories synchronous and deterministic.

## Package managers

Package managers are ordinary feature graphs. Built-ins are `npm()`, `pnpm()`, and `yarn()`. They
provide ordinary `installManifest`, `exec`, and `pack` functions and contribute commands/files.
Custom managers provide the same graph bindings directly. Do not infer a manager from the base image
or add a manager registry.

Local package dependencies arrive from sibling `ci:pack` targets as tarballs. Install rendering may
replace their manifest ranges with `file:` references. Pack and publish rendering restores the public
ranges.

## Working procedure

Trace behavior from an ordinary fact through the contribution that renders it and the local target
that selects its context. Prefer deleting an abstraction over adapting it when normal RDK composition
already handles the job.

Keep `README.md`, `AGENTS.md`, `llms.txt`, this skill, workflows, mounts, and publication paths current
when structure or public behavior changes.

Validate with:

```sh
dagr run //recipes:ci:test
dagr run //recipes:ci:image-rdk
dagr run //recipes:ci:image-typescript
```
