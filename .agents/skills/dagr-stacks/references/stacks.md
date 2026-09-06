# Dagr stack architecture

Use this reference when authoring, extending, reviewing, or debugging reusable components under `stacks/`.

Canonical source material:

- `stacks/README.md`
- `stacks/typescript/README.md`
- `stacks/di/README.md`

## What a stack owns

A stack is a self-contained JavaScript factory for a project archetype. It accepts facts and developer intent and returns a complete Dagr index.

Generated tool files are outputs. They should not become a second source of project truth.

A stack should own consistency between tools. If several generated outputs must agree on a decision, model that decision once as a semantic calculation and derive all tool-specific fields from it.

Examples:

```text
outputLayout
  ├── packageJson.main / exports / files
  └── tsconfig.compilerOptions.outDir

sourceAlias
  ├── packageJson.imports
  ├── tsconfig.compilerOptions.paths
  └── vite.resolve.alias
```

Do not make one tool's generated setting canonical for another tool.

## Component boundaries

Each top-level directory under `stacks/` is independently consumable.

Build stacks use:

```text
<stack>/
├── dagr.stack.js       public entry point
└── dagr.*              internal/importable support files
```

`dagr.stack.js` default-exports the public stack factory. Keep everything required by the mounted component inside its directory. Repository-level tests belong under `stacks/tests/`, not inside published component directories unless they are part of the component itself.

Supporting components may expose a descriptive entry point such as `dagr.di.js` instead of `dagr.stack.js`.

## TypeScript stack composition

The composable TypeScript stack follows this shape:

```js
const stack = typescript(options)
  .with(product(...))
  .with(capability(...))
  .with(capability(...))

export default stack({
  location: import.meta.dagr.location,
  version,
  deps,
  metadata,
})
```

`typescript(options)` supplies common stack policy and machinery. Every `.with(...)` argument is an ordinary DI module merged into the same graph. The package declaration supplies per-package facts.

The final graph resolves one root:

```js
module.shake(['index']).compile().index
```

There is no selected-target input. Dagr target selection happens after the stack has produced the complete index.

## Package facts stay small

The package declaration should contain only information that cannot sensibly be derived, currently things such as:

- `location`
- `version`
- dependencies
- passive package metadata

Avoid adding package inputs for consequences already derivable from product choice, intent, conventions, or other facts. Examples that should remain calculated include:

- `private`
- output directories
- package entry points and exports
- generated files
- scripts
- emitted artifacts
- registry visibility/authentication policy

A new option is suspicious when a downstream calculation could answer the same question from existing facts.

## Conventions versus package configuration

Cross-project defaults belong in stack conventions when they represent a convention rather than an intrinsic package fact. A convention is still a DI binding and can be replaced at the owning node:

```js
typescript({
  conventions: {
    sourceDirectory: 'source',
    outputDirectory: 'build',
  },
})
```

Downstream nodes should follow automatically through dependencies. Do not compensate by independently overriding every generated field affected by the convention.

## Products

A product feature describes what is being built. Examples include `library()`, `cloudflareWorker()`, and `viteReact()`.

Product features should provide tool-neutral facts and semantic calculations first, then let shared machinery derive generated configuration and targets. Do not expose low-level tool settings as public product options merely because a tool needs them.

Exactly one coherent product model should own product semantics for a package. Avoid composing incompatible product definitions that claim the same conceptual nodes.

## Capabilities

Capabilities add optional behavior such as formatting, testing, linting, or documentation. Examples include `prettier()`, `biome()`, `vitest()`, `eslint()`, and `typedoc()`.

A capability normally contributes some combination of:

- feature facts
- derived semantic/tool settings
- default package versions
- generated files
- tool/runtime packages
- validations
- Dagr targets

Use DI dependencies for requirements between capabilities. Do not maintain a second feature-dependency registry.

## Generated configuration

Treat configuration documents as assemblers over field-level calculation nodes. Keep a field separate when it participates in invariants or is shared with another generated output.

Prefer:

```text
runtimeEntry -> packageJson.main
runtimeEntry -> packageJson.exports
```

over calculating the whole package manifest in one opaque factory.

Passive metadata that has no behavioral dependency can remain bundled rather than becoming gratuitous graph nodes.

## Contributions and tags

Use tags only where contributors are intentionally open-ended. Common aggregation points are generated files, package lists, validations, rule sets, build dependencies, targets, and facets.

Collectors receive all contributions and own conflict policy. A collision between two independently contributed generated files or public target names should be visible, not resolved by accidental iteration order.

See [How stacks use DI](di.md) for the detailed rule.

## Targets and facets

A target contribution is still an ordinary Dagr target plus its public `name`. Tag it with the owning facet's target tag. The facet collector assembles the public target map, and the root index collector assembles facets.

Do not add feature roles, execution registries, or target-kind interpreters. If a target needs configuration or another target, express those relationships in its calculation and native Dagr `deps`.

## Mounting and publication

Published stack components are immutable filesystem images. Consumers request a component through `dagr.mount.yaml`; the consuming repository's root `.dagr/config.js` owns canonical volume identity and `.dagr/volumes.yaml` selects the concrete image implementation.

A consuming repository normally imports the mounted stack across the mount boundary:

```js
import typescript from '//stacks/ts//dagr.stack.js'
```

The mount alias is consumer-owned. Stack code should not assume which alias a consuming repository chose.

Published component images finish with `WORKDIR /stack`, allowing Dagr to materialize the component contents directly. Consumers should pin immutable versions/tree SHAs rather than depending on `latest` for reproducible builds.

## Validation

For repository changes, start with the stack test target:

```sh
dagr run //stacks:ci:test
```

When changing emitted stack images or mount behavior, also inspect/build the relevant image target from `stacks/dagr.index.js`, for example:

```sh
dagr show //stacks:ci:image-typescript
dagr run //stacks:ci:image-typescript
```

Use the narrowest relevant tests first. Inspect nearby tests in `stacks/tests/` for expected composition and failure behavior before adding new conventions.
