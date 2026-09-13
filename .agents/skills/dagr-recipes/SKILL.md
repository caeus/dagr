---
name: dagr-recipes
description: Work with Dagr reusable recipes and native RDK contributions under recipes/. Use when modifying the TypeScript recipe, package-manager behavior, generated files, commands, targets, mounts, publication, or `dagr:rdk` composition.
---

# Dagr recipes

Use this skill for reusable recipes under `recipes/`, especially the TypeScript recipe and its synchronous graph built with the engine-native `dagr:rdk` library.

## First orient yourself

1. Read `recipes/README.md` and the nearest recipe `README.md`.
2. Classify each value as an irreducible fact, an ordinary calculation, or a rendered output.
3. Inspect the current input path before adding a binding.
4. Read the relevant reference:
   - [Recipe architecture](references/recipes.md)
   - [How recipes use RDK](references/rdk.md)

## Core model

A TypeScript recipe contains one immutable RDK graph. It is a flat collection of bindings addressed by absolute semantic paths. Derived bindings declare a named input object: `rdk.one('/path')` requires one exact value, `rdk.many('/path')` injects an exact value optionally, and wildcard `many()` selectors collect open aggregates. Every `many()` returns a frozen record, and multiple selectors are unioned into it.

Features own canonical values such as `/typescript/package-json`, `/vitest/tester`, and
`/eslint/tooling`. Singular language capabilities stay in their semantic namespace, for example
`/typescript/compiler`, `/typescript/tester`, and `/typescript/linter`. An implementation-owned
binding may project into that capability path. Open integration uses additional adapter bindings
ending in protocol paths such as `/hoisted`, `/package-json/dependencies`, `/package-json/script`,
`/tsconfig/types`, or `/package-manager/builds`.

`recipe(features)` returns a builder. Applying one package declaration merges its facts and runs:

```js
graph.compile(['/dagr/index'])['/dagr/index']
```

The index derives facet and name from every `/target/<facet>/<name>` binding and returns the grouped result. There is no facet registry.

## Modeling rules

- Import RDK from `dagr:rdk`; do not mount or publish a separate RDK recipe.
- Keep declarations limited to `location`, `version`, dependencies, and metadata.
- Keep shared semantics as ordinary RDK bindings with paths such as `/source/directory`.
- Give each feature canonical bindings for its rendered files, tooling, and executable commands.
- Project canonical commands into exact capability bindings inside the semantic domain that owns the
  abstraction. TypeScript targets use `/typescript/compiler`, `/typescript/tester`,
  `/typescript/linter`, `/typescript/documenter`, and `/typescript/bundler`, leaving other language
  namespaces free to coexist in the same graph.
- Put dependencies at their semantic cause-site. A compiler names its tsconfig; a linter names its
  config. Commands carry exact optional file sets to their targets. Never wildcard-discover normal
  target files. Project canonical files into `/**/hoisted` only for the open host-output protocol.
- Project canonical tooling into the aggregate that consumes each field: package names into
  `/**/package-json/dependencies`, ambient types into `/**/tsconfig/types`, and build allowances into
  `/**/package-manager/builds`.
- Use wildcard `many()` selectors only for genuinely plural, open aggregates. Exact-path `many()` is
  optional injection. Do not rank, filter, or pick one member to satisfy a singular dependency.
- Pass `intent`, `facet`, and `host` through render context; never make all graph values contextual.
- Let targets select their context and explicitly render the contributions they need.
- Keep target values native Dagr `{ name, deps, run }` objects.
- Do not add graph copies, registries, installer/builder/projector layers, or another evaluator.
- Make ownership collisions visible. Never depend on contribution order.
- Keep factories synchronous and deterministic.

## Package managers

Package managers are ordinary feature graphs. Built-ins are `npm()`, `pnpm()`, and `yarn()`. They
provide the exact `/package-manager/**` capabilities, canonical `/package-manager/config`, and
the `/package-manager/config/hoisted` adapter. Custom managers provide the same paths directly. Do
not infer a manager from the base image or add a manager registry.

Local package dependencies arrive from sibling `ci:pack` targets as tarballs. Install rendering may replace their manifest ranges with `file:` references. Pack and publish rendering restores the public ranges.

## Working procedure

Trace behavior from an ordinary fact through the contribution that renders it and the local target that selects its context. Prefer deleting an abstraction over adapting it when normal RDK composition already handles the job.

Keep `README.md`, `AGENTS.md`, `llms.txt`, this skill, workflows, mounts, and publication paths current when structure or public behavior changes.

Validate with:

```sh
dagr run //recipes:ci:test
dagr run //recipes:ci:image-typescript
```
