# How Dagr stacks use DI

Dagr stacks use the tiny synchronous DI implementation in `stacks/di/dagr.di.js` as a calculation DAG, not as a runtime service locator.

For the generic API, read `stacks/di/README.md`. This reference focuses on the modeling conventions used by the stacks codebase.

## Primitive operations

```js
import di, { toClass, toFun, toValue } from '//stacks/di//dagr.di.js'

const module = di.module({
  fact: toValue('input'),
  derived: toFun(['fact'], fact => `${fact}!`),
})

const result = module.shake(['derived']).compile().derived
```

- `di.toValue(value, tags?)` provides an already-known fact or contribution.
- `di.toFun(deps, factory, tags?)` calculates a value from explicit dependencies.
- `di.toClass(deps, Class, tags?)` constructs a class from explicit dependencies. It is rarely needed for stack calculations; prefer values and pure functions when possible.
- `di.module(definitions)` creates an immutable module.
- `module.merge(other)` returns a new right-biased module. A definition in `other` replaces the complete definition under the same key, including its tags.
- `module.shake(roots)` retains only the requested roots and their transitive direct/tag dependencies.
- `module.compile()` eagerly initializes every retained binding exactly once and returns the container. It is synchronous and does not await promises.

Compilation rejects missing and circular dependencies. Shake before compile when unrelated bindings should not initialize.

## One graph, not two

The composable TypeScript stack intentionally has one calculation graph:

```js
module.shake(['index']).compile().index
```

Do not add a second manifest evaluator, calculation registry, feature registry, target registry, or post-processing graph when the relationship can be expressed as DI bindings and dependencies.

Feature modules are merged into that same graph. The stack's `.with(feature)` is effectively module composition, not a separate plugin runtime.

## Keys are concepts

DI keys are plain JavaScript property keys. In the TypeScript stack they usually describe one fact or calculation:

```text
location
intent
outputLayout
runtimeEntry
packageJson.main
tsconfig.compilerOptions.outDir
ci:test/packageJson.private
```

Name a node for the concept it owns, not for the function that happens to compute it.

Use path-shaped or workspace-qualified keys when the same conceptual field exists in multiple generated workspaces. Do not hide behavior inside one large `packageJson`, `tsconfig`, or manifest calculation when individual fields participate in invariants.

## Facts versus calculations

External facts or feature choices use `toValue`:

```js
di.module({
  productKind: di.toValue('library'),
  sourceMapIntent: di.toValue(true),
})
```

Derived consequences use `toFun`:

```js
di.module({
  emissionIntent: di.toFun(
    ['productKind', 'intent', 'emissionIntents'],
    (product, intent, intents) => product === 'library' && intents.includes(intent),
  ),
})
```

If several outputs need to agree, derive them from a shared semantic node:

```text
outputLayout
  ├── packageJson.main
  ├── packageJson.files
  └── tsconfig.compilerOptions.outDir
```

Do not derive `packageJson.main` from generated `tsconfig.compilerOptions.outDir`, or vice versa. Neither tool is canonical. Both should depend on the shared semantic decision.

## Direct dependencies are the default

Use named dependencies for behavioral relationships:

```js
di.toFun(['outputLayout', 'distributionIntent'], (layout, distribution) => ...)
```

This keeps ownership, invariants, and causal paths inspectable.

A feature may deliberately require another capability by depending on one of its bindings. Do not add a separate `requires: ['eslint']` registry. If `companyEslintRules` needs `eslint.enabled`, make that a DAG dependency. Missing composition then fails naturally as a missing binding.

## Tags are for open sets

Providers may carry tags. A `{ tag }` dependency receives a frozen record of every matching binding, keyed by binding name:

```js
const generatedFiles = di.toFun(
  [{ tag: 'generatedFiles' }],
  contributions => mergeGeneratedFiles(contributions),
)
```

Use tags when the set of contributors is intentionally open-ended and independently extensible. Current stack examples include:

- `toolPackages`
- `runtimePackages`
- `ambientTypes`
- `generatedFiles`
- `allowBuilds`
- `versionDefaults`
- `validations`
- `buildDependencies`
- `eslint.ruleSets`
- each facet's private target tag, such as `ciFacet.targets`

Do not use tags merely to avoid naming dependencies. Semantic settings should normally remain direct dependencies.

Tag collection is module-wide and unordered. Never rely on contribution order. Aggregators should define explicit collision policy; generated-file and public-name collisions should fail rather than silently select a winner.

## Targets and facets are contributions

Targets stay native Dagr values:

```js
import { ciFacet, di, target } from '//stacks/ts//dagr.stack.js'

export const health = () => di.module({
  healthTarget: di.toFun(
    [],
    () => target('health', {
      deps: [],
      run: () => ({
        FROM: 'alpine:3.22',
        steps: [{ RUN: 'echo healthy' }],
        IGNORE: [],
      }),
    }),
    [ciFacet.targets],
  ),
})
```

The value contributed to the facet is still `{ name, deps, run }`. The facet collector uses `name` as the public target key. Facets themselves are collected into the final index through another tag.

Conceptually:

```text
calculation nodes
      |
      v
healthTarget --tag(ci.targets)--> facet:ci --tag(facets)--> index
```

Target selection is not an input to this graph. Dagr receives the complete index and selects targets afterward.

## Overrides and ownership

`merge` is right-biased, which makes deliberate replacement possible. Treat that as an ownership tool, not as an excuse for accidental duplicate semantics.

When changing a convention or behavior, prefer replacing the node that owns the concept so all downstream calculations update through dependencies. Avoid overriding several generated fields independently to force them back into agreement.

Open-ended aggregators should detect incompatible duplicate public ownership where appropriate. Never make correctness depend on which tagged contribution happened to be visited last.

## Keep calculations deterministic

Stack code executes in Dagr's restricted JavaScript environment. Keep factories synchronous and deterministic. Do not design DI nodes around filesystem reads, environment variables, network access, timers, mutable ambient state, or asynchronous resolution.

Promises are ordinary DI values and are not awaited by `compile()`. Stack calculations should normally remain plain synchronous values.
