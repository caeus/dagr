# Dagr component architecture

Use this reference when authoring, extending, reviewing, or debugging reusable components under `components/`.

Canonical source material:

- `components/README.md`
- `components/typescript/README.md`
- `components/di/README.md`

## Component boundaries

Each top-level directory under `components/` is independently consumable. A component contains everything required when mounted or published. Repository-only tests belong under `components/tests/`.

A build stack exposes `dagr.stack.js`. Supporting components may expose another descriptive entry point such as `dagr.di.js`.

## What the TypeScript stack owns

The TypeScript stack accepts project facts, conventions, product/capability features, and explicit execution choices such as the base target and package manager. It returns a complete Dagr index.

Generated configuration is not canonical input. When several outputs must agree, model the decision once and derive each tool field from it.

Examples:

```text
outputLayout
  ├── packageJson.main / exports / files
  └── tsconfig.compilerOptions.outDir

importAlias
  ├── packageJson.imports
  ├── tsconfig.compilerOptions.paths
  └── vite.resolve.alias
```

## Composition

The stack follows this shape:

```js
const stack = typescript({
  base,
  packageManager,
  versions,
})
  .with(product(...))
  .with(capability(...))

export default stack({ location, version, deps, metadata })
```

Every `.with(...)` value is an ordinary DI module merged into the same graph. The final root is `index`; target selection happens later in Dagr.

## Package managers

Package manager choice is an explicit stack fact. Do not infer it from a base image or target name.

Package-manager adapters own:

- dependency installation
- local binary execution
- host-specific install flags
- package packing
- manager-specific generated files

Features should provide raw tool commands, not embed `npm`, `pnpm`, or another manager directly.

Local package dependencies are copied as tarballs from their Dagr `ci:pack` targets. The install-only package manifest rewrites those dependencies to `file:` URLs so this mechanism is package-manager-neutral.

## Products and capabilities

A product feature describes what is being built, such as `library()`, `cloudflareWorker()`, or `viteReact()`. Capabilities add optional behavior such as formatting, tests, linting, or documentation.

Exactly one coherent product model should own product semantics. Capabilities can contribute settings, generated files, packages, validations, and native Dagr targets.

## Publication and mounting

Published component images are immutable filesystem images and finish at `WORKDIR /component`. Root `.dagr/config.js` owns volume identity; `.dagr/volumes.yaml` selects the implementation for workspace development.

Consumers choose local mount aliases. Component code must not assume a particular alias.

## Validation

Start with:

```sh
dagr run //components:ci:test
```

Then build the relevant image target when component contents, mounts, or publication change.
