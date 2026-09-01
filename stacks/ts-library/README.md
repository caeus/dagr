# TypeScript library stack

A curried dagr stack for TypeScript libraries, extracted from
[`caeus/caeus.github.io`](https://github.com/caeus/caeus.github.io/tree/df44fa552979c8cb622490446ab39efa7a7eed56/stacks).

The first call supplies repository policy and returns a reusable stack function. The second call
declares the facts and intent of one library. The selected dagr target supplies the action. Tool
configuration is derived from all three.

```js
// dagr.typescript.js in the consuming repository
import typescript from '//stacks/typescript//dagr.stack.js'
import versions from '//config/dagr.versions.yaml'

export default typescript({
  base: '//packages/base:ci:node-pnpm',
  scope: 'internal',
  versions: versions.deps,
  testEnvironment: 'node',
})
```

```js
// packages/common/dagr.index.js
import stack from '//dagr.typescript.js'

export default stack({
  location: import.meta.dagr.location,
  version: '0.1.0',
  deps: [
    { npm: 'zod', at: 'prod' },
    { pkg: '//packages/contracts', at: 'prod' },
  ],
  metadata: {
    description: 'Shared domain types',
    license: 'MIT',
  },
})
```

## Configuration model

There is deliberately no canonical generated `package.json`, `tsconfig.json`, or Vitest config.
Each is a terminal value in an explicit calculation DAG.

| Node kind | Supplied by | TypeScript stack examples |
| --- | --- | --- |
| `external` | repository/package declaration or stack policy | location, dependency versions, test intent, source convention |
| `target` | the dagr target requesting the projection | `dev:sync`, `ci:build`, `publish:pack` |
| `calculated` | named dependencies in this graph | action, package name, `private`, `outDir`, `exports`, generated files |

Facts, intent, and irreducible policy enter through external nodes. The target enters through a
target node. Everything determined by those sources is a calculated node and must not also be
independently configurable.

## Calculation DAG

[`dagr.projections.js`](dagr.projections.js) declares every node and incoming edge as data:

```js
export const TYPESCRIPT_LIBRARY_DAG = { nodes: {
  location: external(),
  scope: external(),
  versions: external(),
  targetActions: external(),

  target: target(),

  action: calculated(['target', 'targetActions'], calculateAction),
  name: calculated(['location', 'scope'], calculateName),
  publishable: calculated(['action', 'publishAction'], calculatePublishability),
  outputImport: calculated(['outputDirectory', 'outputStem'], calculateOutputImport),
  packageJson: calculated([
    'name',
    'publishable',
    'outputImport',
    // ...every other direct input
  ], calculatePackageJson),
  tsconfig: calculated([
    'typescriptPolicy',
    'sourceDirectory',
    'outputDirectory',
    'emit',
  ], calculateTsconfig),
  files: calculated([
    'packageJson',
    'tsconfig',
    'vitestConfig',
    'prettierConfig',
  ], calculateFiles),
  projection: calculated([
    'target',
    'action',
    'packageJson',
    'tsconfig',
    'files',
    'output',
  ], calculateProjection),
} }
```

The actual declaration contains the complete dependency lists rather than the abbreviated lists
above. Tests assert the source kinds and important edges so provenance cannot drift back into
implicit code.

The graph does not implement its own evaluator. The stack mounts the [`di`](../di/) component at
the exact merge commit from PR #2. External and target nodes become `toValue` bindings; calculated
nodes become `toFun(deps, factory)` bindings. The three binding modules are merged, shaken to the
`projection` root, and compiled by DI:

```js
externalModule
  .merge(targetModule)
  .merge(calculatedModule)
  .shake(['projection'])
  .compile()
```

DI remains responsible for dependency resolution, missing bindings, cycles, immutability, and
single evaluation. The projection layer only adds node provenance and TypeScript-library
calculations.

`action` is calculated from the selected target. Callers cannot independently request a publish
action for `ci:pack`, which is the contradiction that a separate `private` input used to permit.

That has some important consequences:

- `metadata` is allowlisted passive information. Supplying `private`, `files`, `main`, `types`,
  `exports`, dependencies, scripts, `publishConfig`, or any other behavioral field fails with an
  explicit error.
- Compiler output and package entry points use one stack-owned output agreement. A consumer never
  has to make `outDir` agree with `files`, `main`, or `types`.
- Development and CI do not share a manifest merely because their current values look similar.
  Every target asks the projector for its own configuration.
- Registry visibility, authentication, provenance, and tags belong to the publishing location.
  They are not package inputs, and this stack never generates npm `access` configuration.

## Projections and targets

| Target | Projection | Materialized configuration | Publishable |
| --- | --- | --- | --- |
| `dev:sync` | `dev` | source-oriented package manifest, no-emit TypeScript, Vitest, Prettier | No |
| `ci:typecheck` | `typecheck` | source-oriented package manifest and no-emit TypeScript | No |
| `ci:test` | `test` | source-oriented package manifest, no-emit TypeScript, Vitest | No |
| `ci:build` | `build` | build manifest and emitting TypeScript config | No |
| `ci:pack` | `pack` | distribution manifest over build output | No |
| `publish:pack` | `publish` | distribution manifest over the same build output | Yes |

`dev:sync` exports only the `dev` projection. It includes test configuration because tests are part
of the local editing experience, but it does not export build, pack, or publish configuration.
Each CI target materializes its own projection inside its build image and does not consume files
checked into the repository.

`ci:pack` exists for local dagr package dependencies and remains `private: true`.
`publish:pack` is a publishing target, so its generated manifest has `private: false`. It produces
a publishable tarball but does not choose or contact a registry. The adapter for the selected
publishing location owns that operation and its visibility policy.

The stack passes `project(target)` and the inspectable `calculations` graph to
`transform(index, context)` so repository composition can reuse a known target projection without
reaching into raw package or TypeScript configuration.

## Generated-unit mapping

| Unit | Source |
| --- | --- |
| package `name` | derived from logical `location` and repository `scope` |
| package `version` | package fact |
| descriptive package metadata | package fact |
| package `type`, source entry point | TypeScript ESM library intent |
| package `private` | action: false only for the `publish` projection |
| package `main`, `types`, `exports`, `files` | source convention for development; compiler output agreement for distribution |
| package runtime dependencies | declared `prod` dependencies plus repository version policy |
| package development dependencies | declared `dev` dependencies plus tools required by the selected development/build action |
| package scripts | omitted; dagr targets encode actions |
| package `publishConfig` / npm `access` | omitted; publishing location policy |
| TypeScript `rootDir`, `include`, test exclusions | TypeScript library source and test conventions |
| TypeScript `outDir` | stack-owned output agreement shared with distribution package fields |
| TypeScript `noEmit`, `declaration` | action |
| TypeScript language/module settings | TypeScript ESM library stack policy |
| Vitest environment | repository test intent |
| Prettier settings | development stack policy |

## Inputs

`typescript(options)` accepts repository policy:

- `base`: target providing Node and pnpm. Defaults to `//packages/base:ci:node-pnpm`.
- `scope`: generated npm scope. Defaults to `internal`.
- `versions`: npm package version map.
- `ignore`: repository-specific dagr build-context exclusions.
- `testEnvironment`: meaningful test-runtime intent. Defaults to `node`.
- `transform(index, context)`: composition hook. Its context contains `project(target)` and the
  calculation graph.

The stack is still independently mountable. Its `di/` namespace slot is a nested sparse mount
pinned to the DI merge commit, so consumers do not need to mount the sibling component themselves.

The returned stack accepts package facts and intent:

- `location`: normally `import.meta.dagr.location`.
- `version`: defaults to `0.1.0`.
- `deps`: `{ npm, at }` or `{ pkg, at }` dependencies, where `at` is `prod` or `dev`.
- `metadata`: non-derived package metadata such as description, license, repository, or keywords.

Packed libraries carry the transitive closure of local package tarballs.
