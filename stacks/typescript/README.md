# Composable TypeScript stack

This component calculates generated tool configuration, executable targets, facets, and finally a
complete Dagr index. Consumers mount only this directory.

```js
import typescript, {
  eslint,
  library,
  prettier,
  typedoc,
  vitest,
} from '//stacks/ts//dagr.stack.js'
import versions from '//config/dagr.versions.yaml'

const stack = typescript({
  base: '//packages/base:ci:node-pnpm',
  scope: 'caeus',
  versions,
})
  .with(library({ runtime: 'node', sourceMaps: true, assets: ['README.md', 'LICENSE'] }))
  .with(prettier({ semi: true, trailingComma: 'all' }))
  .with(vitest({ globals: true, typecheck: true }))
  .with(eslint({ prettier: true, explicitReturnTypes: true }))
  .with(typedoc({ title: 'Wyr' }))

export default stack({
  location: import.meta.dagr.location,
  version: '0.1.0',
  metadata: { license: 'MIT' },
})
```

`typescript()` owns the common settings and target machinery. Each `.with(...)` argument adds
ordinary DI definitions. Everything is merged into one native `di.module()` and the stack resolves
one root:

```js
module.shake(['index']).compile().index
```

There is no `program`, `calculationModule`, or second graph evaluator. Workspace-specific fields are
ordinary qualified DI bindings. A small constructor emits names such as
`ci:test/packageJson.private` directly from native definitions.

The topology is graph-first, not manifest-first:

```text
conventions + external facts
            |
            v
     semantic settings
            |
            v
  field-level tool settings
            |
            v
 concrete target definitions --tag--> facets --tag--> index
```

Conventions are zero-dependency calculations, not hidden constants in a manifest generator. The
stack supplies them, and a stack author may replace an exceptional convention without making every
project configure it:

```js
typescript({ conventions: { sourceDirectory: 'source', outputDirectory: 'build' } })
```

That replacement changes `outputLayout`; `packageJson.main`, `packageJson.files`, and
`tsconfig.compilerOptions.outDir` then follow through their declared dependencies. Projects that
accept the convention say nothing.

Configuration files are assemblers, not indivisible calculation nodes. Every behavioral field that
participates in an invariant has its own path-shaped node. Tool-neutral nodes sit between intent and
tool fields:

| Semantic node | Derived tool fields |
| --- | --- |
| `outputLayout` | `tsconfig.compilerOptions.outDir` |
| `runtimeEntry` | `packageJson.main`, `packageJson.exports` |
| `declarationEntry` | `packageJson.types`, `packageJson.exports` |
| `emittedArtifacts` | `packageJson.files` |
| `sourceSet` | `tsconfig.include`, `tsconfig.exclude` |
| `sourceAlias` | `packageJson.imports`, `tsconfig.compilerOptions.paths`, `vite.resolve.alias` |

Neither tool is canonical. For example, `packageJson.main` is not calculated from
`tsconfig.compilerOptions.outDir`; both are derived from `outputLayout` and the relevant entry
semantics. `packageJson` and `tsconfig` only assemble their field nodes plus passive metadata.

The transform context exposes `calculations` as the graph structure. A dedicated inspection API is
intentionally left for later.

## DI keys

Keys are plain JavaScript strings. Configuration-specific keys are prefixed by the target whose
workspace they calculate, such as `ci:test/packageJson.private`. Targets are outputs, so there is no
selected-target input. Only convention keys are accepted by `typescript({ conventions })`; all keys
are available to transforms through `calculations.nodes`.

```js
typescript({
  transform(index, { calculations }) {
    for (const [name, definition] of Object.entries(calculations.nodes)) {
      console.log(name, definition.deps, definition.tags)
    }
    return index
  },
})
```

### Core keys

| Source | Keys |
| --- | --- |
| Conventions | `developmentIntents`, `distributionIntents`, `emissionIntents`, `testSourceIntents`, `developmentIntentName`, `publicationIntentName`, `dependencyLocations`, `metadataFields`, `sourceDirectory`, `entryFile`, `outputDirectory`, `javascriptModuleFormat` |
| External package facts | `location`, `scope`, `version`, `deps`, `metadata`, `configuredVersions`, `stackVersionDefaults` |
| Workspace context | `intent` |
| Semantic calculations | `versions`, `name`, `slug`, `validatedMetadata`, `sourceLayout`, `sourceEntry`, `outputLayout`, `distributionIntent`, `emissionIntent`, `testSourcesIncluded`, `sourceSet`, `runtimeEntry`, `declarationEntry`, `emittedArtifacts`, `publishable`, `sourceMapEmission`, `ambientTypes` |
| Feature aggregates | `featureToolPackages`, `featureRuntimePackages`, `featureAmbientTypes`, `featureGeneratedFiles`, `featureAllowBuilds`, `featureVersionDefaults`, `featureValidations` |

### Package and TypeScript settings

| Group | Keys |
| --- | --- |
| Dependency calculations | `dependencyEntries`, `toolDependencyEntries` |
| Package fields | `packageJson.name`, `packageJson.version`, `packageJson.type`, `packageJson.private`, `packageJson.main`, `packageJson.types`, `packageJson.exports`, `packageJson.files`, `packageJson.imports`, `packageJson.dependencies`, `packageJson.devDependencies` |
| Package assembly | `packageJson` |
| TypeScript fields | `tsconfig.extends`, `tsconfig.include`, `tsconfig.exclude`, `tsconfig.compilerOptions.rootDir`, `tsconfig.compilerOptions.outDir`, `tsconfig.compilerOptions.target`, `tsconfig.compilerOptions.lib`, `tsconfig.compilerOptions.module`, `tsconfig.compilerOptions.moduleResolution`, `tsconfig.compilerOptions.noEmit`, `tsconfig.compilerOptions.declaration`, `tsconfig.compilerOptions.sourceMap`, `tsconfig.compilerOptions.inlineSources`, `tsconfig.compilerOptions.types`, `tsconfig.compilerOptions.paths`, `tsconfig.compilerOptions.allowImportingTsExtensions`, `tsconfig.compilerOptions.moduleDetection`, `tsconfig.compilerOptions.jsx` |
| TypeScript assembly | `compilerOptions`, `tsconfig` |
| Workspace assembly | `files`, `allowBuilds`, `output`, `workspace` |

### Product keys

Every product feature provides the same tool-neutral contract:

| Kind | Keys |
| --- | --- |
| Product facts | `productKind`, `runtimeKind`, `languageTarget`, `sourceMapIntent`, `buildAssetInputs` |
| Product calculations | `moduleKind`, `moduleResolutionKind`, `standardLibraries`, `baseAmbientTypes`, `sourceAlias`, `productToolPackages`, `productRuntimePackages`, `productAllowBuilds`, `buildAssets` |
| Product version defaults | `libraryVersionDefaults`, `cloudflareVersionDefaults`, `viteVersionDefaults` |
| Additional `viteReact()` keys | `viteIntents`, `vite.plugins`, `vite.resolve.alias`, `viteConfig`, `viteGeneratedFiles` |
| `library()` targets | `libraryTypecheckConfigTarget`, `libraryTypecheckInstallTarget`, `libraryTypecheckTarget`, `libraryBuildConfigTarget`, `libraryBuildInstallTarget`, `libraryBuildTarget`, `libraryCiPackTarget`, `libraryPublishPackTarget` |
| `cloudflareWorker()` targets | `cloudflareTypecheckConfigTarget`, `cloudflareTypecheckInstallTarget`, `cloudflareTypecheckTarget` |
| `viteReact()` targets | `viteTypecheckConfigTarget`, `viteTypecheckInstallTarget`, `viteTypecheckTarget`, `viteBuildConfigTarget`, `viteBuildInstallTarget`, `viteBuildTarget`, `viteDevInstallTarget` |

### Capability keys

| Capability | Keys |
| --- | --- |
| `prettier()` | `formatSemicolons`, `formatTabWidth`, `formatSingleQuotes`, `formatPrintWidth`, `formatTrailingCommas`, `prettierIntents`, `prettierVersionDefaults`, `prettierToolPackages`, `prettier.$schema`, `prettier.semi`, `prettier.tabWidth`, `prettier.singleQuote`, `prettier.printWidth`, `prettier.trailingComma`, `prettierConfig`, `prettierGeneratedFiles` |
| `biome()` | `biomeFormatterIntent`, `biomeLinterIntent`, `biomeIntents`, `biomeVersionDefaults`, `biomeToolPackages`, `biome.formatter.enabled`, `biome.linter.enabled`, `biomeConfig`, `biomeGeneratedFiles`, `biomeLintConfigTarget`, `biomeLintInstallTarget`, `biomeLintTarget` |
| `vitest()` | `testEnvironment`, `testGlobalsIntent`, `testTypecheckIntent`, `vitestIntents`, `vitestDependencyIntents`, `vitestTypeIntents`, `vitestVersionDefaults`, `vitestToolPackages`, `vitestAmbientTypes`, `vitest.test.environment`, `vitest.test.globals`, `vitest.test.typecheck.enabled`, `vitest.test.exclude`, `vitest.test.root`, `vitestConfig`, `vitestGeneratedFiles`, `vitestAllowBuilds`, `vitestTestConfigTarget`, `vitestTestInstallTarget`, `vitestTestTarget` |
| `eslint()` | `lintFormattingIntent`, `lintExplicitReturnTypesIntent`, `eslintIntents`, `eslintVersionDefaults`, `eslintToolPackages`, `eslint.languageOptions.parser`, `eslint.languageOptions.parserOptions.project`, `eslint.files`, `eslint.testFiles`, `eslint.rules.no-undef`, `eslint.rules.no-redeclare`, `eslint.rules.@typescript-eslint/no-empty-object-type`, `eslint.rules.@typescript-eslint/no-unused-vars`, `eslint.rules.@typescript-eslint/explicit-function-return-type`, `eslint.rules.prettier/prettier`, `eslintRules`, `eslintConfig`, `eslintGeneratedFiles`, `eslintLintConfigTarget`, `eslintLintInstallTarget`, `eslintLintTarget` |
| `typedoc()` | `documentationTitle`, `typedocIntents`, `typedocVersionDefaults`, `typedocToolPackages`, `typedoc.entryPoints`, `typedoc.name`, `typedoc.includeVersion`, `typedoc.excludeExternals`, `typedoc.excludePrivate`, `typedoc.excludeProtected`, `typedoc.exclude`, `typedocConfig`, `typedocGeneratedFiles`, `typedocDocsConfigTarget`, `typedocDocsInstallTarget`, `typedocDocsTarget` |

## Authoring features

Features are ordinary functions returning native DI modules. Inputs use `di.toValue()`; calculated
settings use `di.toFun()` with explicit dependencies and optional contribution tags:

- A setting definition is `{ deps, factory, tags }`.
- A target value is `{ name, deps, run }`.
- A facet is `{ name, targets }`, where `targets` is that facet's collection tag.
- A feature is a native DI module. `.with(feature)` calls `module.merge(feature)`.

```js
import { di } from '//stacks/ts//dagr.stack.js'

export const companyEslintRules = rules => di.module({
  companyEslintRequirement: di.toFun(['eslint.enabled'], () => true, ['validations']),
  companyEslintRules: di.toValue(rules, ['eslint.ruleSets']),
})
```

The requirement is a DAG dependency, not a dependency on the `eslint()` feature module. It is always
validated by the final workspace, so using `companyEslintRules()` without `eslint()` fails with the
missing `eslint.enabled` setting.

Targets are ordinary tagged setting values and retain Dagr's native shape:

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

That internal contribution value is exactly:

```js
{
  name: 'health',
  deps: [],
  run: Function,
}
```

Facet assembly consumes `name` as the target's map key and emits Dagr's public
`{ deps, run }` target shape. There is no target specification or target-kind interpreter. The `ci` facet collects every value
tagged with `ciFacet.targets`; the root facet tag then collects `ci`:

```text
healthTarget --tag(ci.targets)--> facet:ci --tag(facets)--> index
```

The selected target never enters this DI. Dagr selects a target only after DI has returned the
complete index.

There is no feature role or execution registry. Product selection, extension requirements, generated
files, and executable targets are all represented by calculation nodes and edges.

## Products

Exactly one product feature must satisfy the product setting contract. Missing providers fail as
missing DAG bindings; selecting two product features fails because they both own the same settings.
Products are explicit features, not conventions or implicit defaults.

- `library()` derives TypeScript build output, package entry points, tarballs, and publishability.
- `cloudflareWorker()` derives the worker runtime, compiler, package imports, and typecheck target.
- `viteReact()` derives the browser compiler, Vite build, React runtime, and host install target.

Product features express what is being built. They do not expose `rootDir`, `outDir`, package `files`, or
other values that only exist to make tools agree.

## Capabilities

- `prettier()` adds formatting policy and development workspace settings.
- `biome()` adds Biome formatting/linting policy, generated configuration, and `ci:lint`.
- `vitest()` adds test-runtime intent, generated configuration, and `ci:test`.
- `eslint()` adds lint policy, generated configuration, and `ci:lint`.
- `typedoc()` adds documentation intent, generated configuration, and `ci:docs`.

Capabilities contribute named dependency, configuration-field, and generated-file nodes. Open-ended
contributions use DI tags instead of a parallel contribution registry:

| Tag | Collector node |
| --- | --- |
| `toolPackages` | `featureToolPackages` |
| `runtimePackages` | `featureRuntimePackages` |
| `ambientTypes` | `featureAmbientTypes` |
| `generatedFiles` | `featureGeneratedFiles` |
| `allowBuilds` | `featureAllowBuilds` |
| `versionDefaults` | `featureVersionDefaults` |
| `validations` | `featureValidations` |
| `buildDependencies` | A product build target's runtime dependency collector |
| `eslint.ruleSets` | `eslintRules` |
| `<facet>.targets` | The corresponding facet, such as `ciFacet.targets` → `facet:ci` |

Each contributing node carries its tags in the calculation graph. Each collector has a `{ tag }`
dependency and receives a record keyed by the contributing node names. Adding a capability therefore
adds bindings to the graph without separately maintaining an aggregate dependency list. Generated
file collisions still fail instead of silently choosing whichever tool happened to run last.

Tags are only for open-ended collections. Behavioral configuration fields and tool-neutral semantic
nodes remain ordinary named dependencies, so their exact values and invariants stay inspectable.

The bundled version file contains only the TypeScript stack's core fallbacks. Optional products and
capabilities contribute their own fallback catalogs through `versionDefaults` when installed.
Repository-provided `versions` override both. An absent feature contributes neither policy settings
nor versions.

Target and facet assembly uses the same mechanism with private tags. Concrete targets collect into
their facet, and facets collect into the root `index` binding. Duplicate public target names fail
during assembly.

The package declaration accepts only facts that cannot be derived: logical location, version,
dependencies, and passive metadata. `private`, output paths, exports, generated files, scripts, and
registry access are not package inputs. `private` becomes false only for `publish:pack`; the
publishing adapter still owns registry visibility and authentication.
