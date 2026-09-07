# How Dagr components use DI

The DI component at `components/di/dagr.di.js` is a tiny synchronous calculation graph, not a runtime service locator.

## Primitive operations

```js
import di, { toFun, toValue } from '//components/di//dagr.di.js'

const module = di.module({
  fact: toValue('input'),
  derived: toFun(['fact'], fact => `${fact}!`),
})

const result = module.shake(['derived']).compile().derived
```

- `toValue(value, tags?)` provides a known fact or contribution.
- `toFun(deps, factory, tags?)` derives a value from explicit dependencies.
- `toClass(deps, Class, tags?)` constructs a class when needed.
- `module.merge(other)` returns a new right-biased module.
- `module.shake(roots)` retains only requested roots and transitive dependencies.
- `module.compile()` synchronously initializes retained bindings once.

## One graph

The TypeScript stack intentionally has one calculation graph:

```js
module.shake(['index']).compile().index
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

Keep factories synchronous and deterministic. Do not design DI nodes around network access, environment variables, timers, mutable ambient state, or asynchronous resolution. Promises are ordinary values and are not awaited by `compile()`.
