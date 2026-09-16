# Composable TypeScript recipe

This recipe builds a Dagr index from one immutable RDK graph. Every binding has an absolute semantic
path. Named dependencies use `rdk.input()`, with `rdk.one()` and `rdk.many()` as convenience forms.

```js
import recipe, {
  eslint,
  library,
  pnpm,
  prettier,
  typedoc,
  typescript,
  vitest,
} from '//recipes/ts//dagr.recipe.js'

export const nodeLibrary = recipe([
  typescript({ base: '//packages/base:ci:node' }),
  pnpm(),
  library({ runtime: 'node', sourceMaps: true, assets: ['README.md', 'LICENSE'] }),
  prettier({ semi: true, trailingComma: 'all' }),
  vitest({ globals: true, typecheck: true }),
  eslint({ prettier: true }),
  typedoc({ title: 'Wyr' }),
])

export default nodeLibrary({
  location: import.meta.dagr.location,
  version: '1.2.3',
  metadata: { license: 'MIT' },
})
```

The declaration contains only irreducible facts: `location`, `version`, package dependencies, and
package metadata. Generated manifests and tool configuration are file bindings.

## Recipe and builder

`recipe(features)` merges feature graphs and returns a callable builder. Calling it merges the
package declaration and compiles `/dagr/index`.

```js
const stricter = nodeLibrary.with(companyPolicy())

nodeLibrary.graph.bindingOf('/source/directory')
```

Recipes use the exported generic builder:

```js
builder(init, run, graph)
```

The returned function performs `run(graph.merge(init(...args)))`. It exposes its immutable `graph`
and `with(feature)`, which returns another builder with the feature merged in.

## RDK inputs

`rdk.input({ keys, patterns }, project)` is the fundamental input abstraction. Every `keys` entry is
an exact required binding. Every `patterns` entry is an optional zero-to-many selector. The projector
receives frozen path-keyed `keys` and `patterns` records and may return any value; that result is what
the named input exposes to its binding factory.

```js
rdk.derive({
  compiler: rdk.input({
    keys: ['/typescript/compiler', '/typescript/tsconfig'],
    patterns: ['/**/tsconfig/types'],
  }, ({ keys, patterns }) => ({
    command: keys['/typescript/compiler'],
    config: keys['/typescript/tsconfig'],
    types: Object.values(patterns),
  })),
}, ({ compiler }) => ...)
```

`rdk.one('/path')` is the singular required-key convenience form. `rdk.many(...patterns)` returns the
current frozen path-keyed pattern collection unchanged. Its exact-path use remains optional, so
`rdk.many('/feature/config')` yields zero or one entry rather than requiring the binding. Pattern
unions are deduplicated in deterministic graph-key order.

## Semantic paths

Paths carry identity and hierarchy. Features own their canonical values:

- `/typescript/package-json` and `/typescript/tsconfig`
- `/vitest/config`, `/vitest/tooling`, and `/vitest/tester`
- `/eslint/config`, `/eslint/tooling`, and `/eslint/linter`
- `/target/<facet>/<name>`

Additional bindings integrate those canonical values with another feature's protocol. `adapter(path)`
projects one exact canonical binding. `hoister()` discovers `/**/hoisted`; package.json discovers
`/**/package-json/dependencies` and `/**/package-json/script`; tsconfig discovers
`/**/tsconfig/types`; package managers discover `/**/package-manager/builds`. A capability names the
canonical files it needs, using `one()` when required or `many()` with exact paths for an optional
set, and carries that set to its target.

Singular capabilities stay inside the semantic domain that owns them. TypeScript uses exact paths
such as `/typescript/compiler`, `/typescript/typechecker`, `/typescript/tester`,
`/typescript/linter`, `/typescript/documenter`, and `/typescript/bundler`. Implementations such as
`/vitest/tester` or `/eslint/linter` can project into those paths. Another language can own
`/python/compiler`, `/python/tester`, and so on in the same graph without competing for a global
capability name. Consumers use `rdk.one()` and never select an implementation from a collection.

Ordinary values use paths such as `/package/name`, `/source/directory`, `/output/layout`, and
`/package-manager/install`. There is no separate contribution registry.

```js
const health = () => rdk.graph({
  '/health/message': rdk.value('healthy'),

  '/health/report': file({
    message: rdk.one('/health/message'),
  }, {
    for: ['test'],
    render(_context, { message }) {
      return writeText('/repo/health.txt', message)
    },
  }),
  '/health/tester': command({}, {
    for: ['test'],
    files: rdk.many('/health/report'),
    run: () => ({ shell: 'test -s health.txt' }),
  }),
  '/typescript/tester': adapter('/health/tester'),
  '/typescript/tester/package-json/script': adapter('/typescript/tester'),

  '/target/quality/health': target({
    exec: rdk.one('/package-manager/exec'),
    tester: rdk.one('/typescript/tester'),
  }, {
    intent: 'test',
    render(context, { exec, tester }) {
      return {
        deps: [],
        run: ({ host }) => ({
          FROM: 'alpine:3.22',
          steps: [...context.files(tester.files, { host }), ...runSteps(tester.invocations, exec)],
          IGNORE: [],
        }),
      }
    },
  }),
})
```

The target path supplies its Dagr facet and target name. A binding at `/target/quality/health`
becomes `quality:health`.

## Files, commands, and tooling

Files are context-aware; commands are not. `file`, `command`, and `target` take a named input object.
Use `rdk.one('/path')` for one required binding, `rdk.many('/first/**', '/second/**')` for an open
union, and `rdk.input()` when one named role needs multiple required keys, patterns, or reshaping.

A file renderer receives `{ intent, facet, host }` plus one named dependency object and returns one
Dagr step or nested arrays of steps. An empty array means "nothing to do". Any non-step value,
including `undefined` and `false`, is an error. A file binding may render `COPY`, an inline write,
`CMD`, or any other step.

A command renderer receives one named dependency object and returns invocations: `{ tool }` for an
installed binary or `{ shell }` for a literal command line. A consumer decides how to materialize an
invocation:

- a container target maps it through `/package-manager/exec`;
- package.json scripts map it through `/package-manager/script`;
- another runner may choose another representation.

`runSteps(invocations, exec)` performs container materialization. Installation is not a
contribution; a target calls `/package-manager/install` when it creates a fresh image.

`for` is the intent gate. A command's `files` option is a `many()` input containing exact canonical
paths. This puts the dependency on the capability that needs it: a compiler names tsconfig, and a
linter names its configuration. A target passes the capability's resolved `files` record to
`context.files(files, overrides)` and materializes its invocations with `runSteps`.

Package-script projections depend on the language capability rather than directly on the current
implementation. Replacing `/typescript/compiler` therefore updates both the build target and the
`build` script with one graph replacement.

Files and commands default to `order: 0`. Equal orders retain graph key order. Use another numeric
order only where sequence is behavior.

Canonical tooling bindings contain intent-scoped package names, ambient types, and packages whose
build scripts must be enabled. A feature projects each field only into the aggregate that consumes
it: `/feature/package-json/dependencies`, `/feature/tsconfig/types`, or
`/feature/package-manager/builds`. Package.json, tsconfig, pnpm, and yarn collect those protocols
independently.

## Tooling and versions

Tooling `packages` contains names only. Versions come from `/version/catalog`, built from
`dagr.versions.yaml` plus the `versions` option passed to `typescript`. A tooling package with no
catalog entry is an error.

## Targets and index

Target bindings have the form `/target/<facet>/<name>`, for example:

- `/target/ci/typecheck`
- `/target/ci/build`
- `/target/ci/test`
- `/target/ci/lint`
- `/target/ci/docs`
- `/target/ci/pack`
- `/target/publish/pack`

The `/dagr/index` binding selects `/target/**`, derives facet and name from each path, validates local
target dependencies, and returns the Dagr index. A target creates a facet by existing.

Dagr resolves a bare `build` against the depending target's facet and `ci:build` against its package.
The index verifies that one of its target bindings owns those local references. A full
`//package:facet:target` reference belongs to another package and is not checked locally.

Normal graph merge semantics govern ownership. If two features bind `/target/ci/build`, the later
binding replaces the earlier one at that exact semantic path.

## Products and capabilities

Choose one product graph:

- `library()`
- `cloudflareWorker()`
- `viteReact()`

Capabilities such as `prettier()`, `biome()`, `vitest()`, `eslint()`, `typedoc()`, `rollup()`, and
`hoister()` own their canonical file, command, tooling, and target paths. Their adapters implement
only the integration and language-capability protocols they need.

## Working on a host

`hoister()` adds `/target/dev/hoist`. It discovers file contributions structurally with
`rdk.many('/**/hoisted', '/**/hoisted/*')` and materializes only those contributions with the `dev`
intent and the actual host context.

A producer keeps its canonical file separate and opts in through an adapter. There is no
registration call and no dependency on `hoister()`:

```js
const editorConfig = () => rdk.graph({
  '/editor/config': file({}, {
    for: ['dev'],
    render: () => writeJson('/repo/.editor.json', { formatOnSave: true }),
  }),
  '/editor/config/hoisted': adapter('/editor/config'),
})

const ideFiles = () => rdk.graph({
  '/ide/settings': file({}, {
    for: ['dev'],
    render: () => writeJson('/repo/.vscode/settings.json', {}),
  }),
  '/ide/hoisted/settings': adapter('/ide/settings'),
})
```

The built-in generated manifest, TypeScript config, development tool configs, and package-manager
config use the same convention. A bundle-only file such as Rollup config is not hoisted because it is
not a host development file.

Run the hoist target with:

```sh
dagr run //packages/example:dev:hoist
```

The target copies local sibling tarballs but no source, renders the marked files, and exports
`/repo/` to the package directory. It does not install. Dependencies resolved inside a Linux image
are the wrong ones for a host, so run the package manager on the host afterwards.

`sourceTarget({ intent, command, files, assets, export })` implements targets that copy local tarballs
and source, render an exact optional file set, install dependencies, run one exact command capability,
and optionally export results. Its own file set names package.json and package-manager config; it
also renders the exact files owned by the selected command. Additional target-owned paths may be
passed through `files`. No file dependency uses a wildcard selector.

`rollup({ bundleDirectory, strict })` adds `/target/ci/bundle` and supporting bindings. It consumes
`/output/layout` and `/package/slug`; a product that emits no JavaScript entry is rejected.

## Package managers

`npm()`, `pnpm()`, and `yarn()` are feature graphs. Each owns these replaceable semantic paths:

- `/package-manager/install-manifest`
- `/package-manager/exec`
- `/package-manager/script`
- `/package-manager/install`
- `/package-manager/pack`
- `/package-manager/config`
- `/package-manager/config/hoisted`

Because the paths are shared, normal right-biased graph merging makes the last manager complete. The
base image does not imply a manager.

A custom manager provides the same bindings directly:

```js
const bun = () => rdk.graph({
  '/package-manager/install-manifest': rdk.value(fileTarballs),
  '/package-manager/install': rdk.value(() => 'bun install'),
  '/package-manager/exec': rdk.value(command => `bun x ${command}`),
  '/package-manager/script': rdk.value(command => command),
  '/package-manager/pack': rdk.value(slug =>
    `bun pm pack --destination /out --filename ${slug}.tgz`),

  '/package-manager/config': file({}, {
    for: ['dev', 'typecheck', 'test', 'lint', 'docs', 'build'],
    render: () => writeText('/repo/bunfig.toml', '[install]\nexact = true\n'),
  }),
  '/package-manager/config/hoisted': adapter('/package-manager/config'),
})
```

## Local project dependencies

A dependency on another project in the repository names the **facet** it needs, not just the package:

```js
deps: [
  { facet: '//packages/core:ci', at: 'prod' },
]
```

The package is derived from the reference, so it is never declared twice. Choosing `pack` within that
facet is still this recipe's decision — the reference resolves to `//packages/core:ci:pack` — which
leaves room for a dependency to identify a capability later without changing what a dependant writes.

A reference with no facet, or a `{ pkg: ... }` declaration, is rejected.

Those tarballs arrive from the sibling's pack target. Install rendering may replace their manifest
ranges with `file:` references; pack and publish rendering restores the public ranges.
