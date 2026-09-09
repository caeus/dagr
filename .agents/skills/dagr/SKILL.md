---
name: dagr
description: Work effectively with Dagr repositories and the Dagr codebase. Use when authoring, modifying, debugging, reviewing, or explaining dagr.index.js, dagr.mount.yaml, .dagr configuration, Dagr target addresses, facets, targets, recipes, dependencies, exports, mounts, CLI commands, or Dagr engine implementation.
---

# Dagr

Use this skill whenever the task involves Dagr, whether Dagr is being used by another repository or Dagr itself is being developed.

## First orient yourself

1. Find the nearest `dagr.index.js` files and inspect local patterns before inventing new ones.
2. Run `dagr list` to see the source packages and targets Dagr can currently load.
3. Use `dagr show <address>` to inspect a target recipe without building it.
4. Read only the reference material relevant to the task:
   - [Authoring and debugging](references/authoring.md) for targets, addresses, recipes, dependencies, imports, mounts, exports, and common traps.
   - [Developing Dagr](references/development.md) when changing Dagr's own engine, docs, examples, or recipes.

## Core mental model

Dagr is a programmable monorepo build system. A package is a directory containing `dagr.index.js`. Each package exports facets, and each facet contains targets. A target is a `{ deps, run }` pair. A completed target is a Docker image that downstream targets can continue from or copy files from.

The graph is repository-owned JavaScript, not a fixed Dagr schema beyond the small target and recipe formats. Do not impose meanings on facet names such as `ci`.

## Rules agents commonly get wrong

- `deps` is required, including `deps: []`.
- `run` is required and returns a recipe.
- Recipe `steps` is required, including `steps: []`.
- Recipe `IGNORE` is required. `IGNORE: []` means upload the whole package context.
- `ctx.images` is keyed by dependency strings exactly as authored in `deps`, not by their resolved fully-qualified addresses.
- `dagr.index.js` runs in a restricted deterministic JavaScript environment. Do not use `process`, `require`, `fetch`, `fs`, arbitrary Node packages, timers, host filesystem reads, or environment reads.
- Ordinary `COPY.src` is relative to the package build context and cannot escape it. `//` inside a source path deliberately crosses a mount boundary.
- Only a directly requested target materializes its own `EXPORT`; exports from transitive dependencies do not write to the host.
- A facet name is just a user-chosen string. Dagr assigns it no built-in semantics.

## Working procedure

Prefer the smallest change consistent with nearby Dagr definitions. Reuse repository helpers and generated target patterns when present rather than expanding repeated configuration manually.

Before running expensive work, inspect with `dagr list` and `dagr show`. After editing, validate the smallest relevant target or target set with `dagr run`.

When behavior is unclear, prefer the repository's pinned Dagr behavior and canonical docs over generic build-system assumptions.

Canonical documentation: https://caeus.github.io/dagr/
Machine-oriented documentation index: https://caeus.github.io/dagr/llms.txt
Source: https://github.com/caeus/dagr
