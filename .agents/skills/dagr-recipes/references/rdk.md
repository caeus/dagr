# How Dagr recipes use RDK

The RDK recipe at `recipes/rdk/dagr.rdk.js` is a tiny synchronous calculation graph.

## Primitive operations

```js
import rdk, { derive, value } from '//recipes/rdk//dagr.rdk.js'

const graph = rdk.graph({
  fact: value('input'),
  derived: derive(['fact'], fact => `${fact}!`),
})

const result = graph.shake(['derived']).compile().derived
```

- `value(input, tags?)` provides a known fact or contribution.
- `derive(deps, factory, tags?)` derives a value from explicit dependencies.
- `construct(deps, Class, tags?)` constructs a class when needed.
- `graph.merge(other)` returns a new right-biased graph.
- `graph.shake(roots)` retains only requested roots and transitive dependencies.
- `graph.compile()` synchronously initializes retained bindings once.

## One graph

The TypeScript stack intentionally has one calculation graph:

```js
graph.shake(['index']).compile().index
```

Features merge into that graph. Do not add another registry or evaluator for calculations, features, targets, or generated manifests.

## Keys are concepts

Name bindings for the fact or calculation they own, for example:

```text
location
intent
outputLayout
runtimeEntry
packageJson.main
ci:test/packageJson.private
```

Use workspace-qualified keys where the same setting exists in multiple generated workspaces.

## Direct dependencies versus tags

Use named dependencies for behavioral relationships. This keeps causal paths inspectable.

Use tags only when the contributor set is intentionally open-ended, such as:

- `toolPackages`
- `runtimePackages`
- `ambientTypes`
- `generatedFiles`
- `allowBuilds`
- `versionDefaults`
- `validations`
- `buildDependencies`
- `eslint.ruleSets`
- facet target collections

Collectors own collision policy. Never depend on contribution order.

## Shared semantics

If several generated outputs need the same decision, derive them from a shared semantic node rather than from one another:

```text
outputLayout
  ├── packageJson.main
  ├── packageJson.files
  └── tsconfig.compilerOptions.outDir
```

Likewise, package-manager selection is one explicit stack fact. Targets ask the selected adapter to install, execute, or pack rather than independently embedding package-manager commands.

## Determinism

Keep factories synchronous and deterministic. Do not design RDK nodes around network access, environment variables, timers, mutable ambient state, or asynchronous resolution. Promises are ordinary values and are not awaited by `compile()`.
