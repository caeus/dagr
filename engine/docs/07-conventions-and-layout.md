# Conventions and layout

A package is any directory containing a `dagr.index.js`. Its root-relative path, prefixed with
`//`, becomes the package name.

The repository layout belongs to the repository. `engine/`, `stacks/`, `apps/`, `services/`, and
`packages/` have no built-in meaning.

## What Dagr enforces

- `dagr.index.js` is the package entry point.
- `dagr list` walks recursively from the repository root.
- `.git` is not searched.
- Discovery continues below directories containing `dagr.index.js`, so nested source packages are
  listed independently.
- A root `dagr.index.js` defines targets such as `//:ci:build` and does not hide packages below it.
- A package name is rooted with `//`. For example, `services/api/dagr.index.js` defines package
  `//services/api` and target `//services/api:ci:build`. A root `dagr.index.js` defines package `//`.
- Direct target loading uses the same package names as discovery. There is no separate `packages/`
  lookup convention.
- A package's Docker build context is its own directory.
- Dagr modules use root-relative `//` imports. Importable files must match `dagr.*.js`,
  `dagr.*.json`, `dagr.*.yaml`, or `dagr.*.toml`.

Everything else is a project convention, including directory names, facet names, target names,
stack aliases, and the location of shared helpers.

## This repository

The Dagr repository deliberately uses two top-level product areas:

```text
dagr/
├── .dagr/                    # launcher used by CI and local development
├── engine/
│   ├── dagr.index.js         # Dagr engine package
│   ├── src/                  # engine implementation
│   ├── docs/                 # public documentation source
│   └── stacks/typescript/    # bootstrap mount for the TypeScript stack
└── stacks/
    ├── dagr.index.js         # stack tests and publishable stack images
    ├── di/                   # DI component
    ├── typescript/           # current composable TypeScript stack
    ├── ts-library/           # earlier TypeScript library stack
    └── tests/                # stack tests
```

Consequently, `dagr list` discovers `engine` and `stacks`. It does not require either directory to
be renamed or placed below `packages/`.

The root currently has no `dagr.index.js`. Adding one would define root targets without changing
discovery below it.

## Choosing a layout

Put each independently addressable build unit in a directory with its own `dagr.index.js`. Group
those directories by domain when that makes the repository easier to understand:

```text
<repo>/
├── engine/dagr.index.js
├── stacks/dagr.index.js
├── services/api/dagr.index.js
└── services/web/dagr.index.js
```

This produces:

```text
//engine:ci:build
//stacks:ci:test
//services/api:ci:build
//services/web:ci:build
```

`dagr list` currently stays within source directories and does not materialize requested volumes.
Mount contents remain addressable when a command explicitly loads a target through that boundary.

## Shared stacks and helpers

Shared code is ordinary importable Dagr code. Its directory name is a convention, not a Dagr
feature. For example:

```js
import { service } from '//build/dagr.service.js'

export default service({ image: 'alpine:3.22' })
```

The `build` directory is a repository convention. A mounted stack could instead be imported through
a project-chosen alias such as `//stacks/toolchain//dagr.stack.js`; the second `//` marks the mount
boundary.

See [Build-file environment and imports](04-sandbox-and-imports.md) for module rules and
[Authoring `dagr.index.js`](03-authoring-dagr-index-js.md) for target definitions, and
[Filesystem composition](03-filesystem-composition.md) for volume mounts.

## Build-context ignores

Discovery exclusions and Docker build-context ignores are different things. Dagr skips `.dagr`
and `.git` while discovering packages. A target controls its Docker context with
`IGNORE`:

```js
run: () => ({
  FROM: 'alpine:3.22',
  steps: [],
  IGNORE: ['.git', 'out'],
})
```

Keep a shared `dagr.dockerignore.js` only when several packages genuinely share the same policy.
Neither that filename nor its location is special to Dagr.
