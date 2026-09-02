# Conventions and layout

Dagr recognizes packages, not JavaScript-style workspaces. A package is any directory containing a
`dagr.index.js`. The directory path becomes the package address.

The repository layout belongs to the repository. `engine/`, `stacks/`, `apps/`, `services/`, and
`packages/` have no built-in meaning.

## What Dagr enforces

- `dagr.index.js` is the package entry point.
- `dagr list` walks recursively from the repository root.
- `.git` and `node_modules` are not searched.
- Discovery continues below directories containing `dagr.index.js`, so nested source packages are
  listed independently.
- A root `dagr.index.js` defines targets such as `//:ci:build` and does not hide packages below it.
- A package path is relative to the repository root. For example, `apps/web/dagr.index.js` defines
  package `apps/web` and target `//apps/web:ci:build`.
- Direct target loading uses the same package paths as discovery. There is no separate `packages/`
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
├── apps/web/dagr.index.js
└── services/api/dagr.index.js
```

This produces:

```text
//engine:ci:build
//stacks:ci:test
//apps/web:ci:build
//services/api:ci:build
```

`dagr list` currently stays within source directories and does not materialize mount declarations.
Mount contents remain addressable when a command explicitly loads a target through that boundary.

## Shared stacks and helpers

Shared code is ordinary importable Dagr code. Its directory name is a convention, not a Dagr
feature. For example:

```js
import typescript, { library } from '//stacks/ts//dagr.stack.js'

const stack = typescript({
  base: '//foundation:ci:node-pnpm',
  scope: 'example',
})
  .with(library({ runtime: 'node' }))

export default stack({
  location: import.meta.dagr.location,
  version: '0.1.0',
  deps: [],
})
```

Here `stacks/ts` is a project-chosen alias for a mounted stack image. The second `//` marks the
mount boundary. Source helpers can also live directly in the repository and be imported with a
single root marker, such as `//build/dagr.helpers.js`.

See [Build-file environment and imports](04-sandbox-and-imports.md) for module rules and
[Authoring `dagr.index.js`](03-authoring-dagr-index-js.md) for mounts and target definitions.

## Build-context ignores

Discovery exclusions and Docker build-context ignores are different things. Dagr itself skips
`.git` and `node_modules` while discovering packages. A target controls its Docker context with
`IGNORE`:

```js
run: () => ({
  FROM: 'node:22-alpine',
  steps: [],
  IGNORE: ['.git', 'node_modules', 'build', 'dist'],
})
```

Keep a shared `dagr.dockerignore.js` only when several packages genuinely share the same policy.
Neither that filename nor its location is special to Dagr.
