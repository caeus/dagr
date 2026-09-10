# Composable TypeScript recipe

This recipe builds a Dagr index from one immutable RDK graph. Every binding has an absolute semantic
path. Exact dependencies name one binding; glob dependencies discover open collections.

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

## Semantic paths

Paths carry both identity and hierarchy. The main open namespaces are:

- `/file/**`
- `/command/**`
- `/target/**`
- `/requirement/**`

Ordinary values use paths such as `/package/name`, `/source/directory`, `/output/layout`, and
`/package-manager/install`. There is no separate contribution registry.

```js
const health = () => rdk.graph({
  '/health/message': rdk.value('healthy'),

  '/file/health': file(['/health/message'], {
    for: ['test'],
    render(_context, message) {
      return writeText('/repo/health.txt', message)
    },
  }),

  '/command/test/health': command([], {
    for: ['test'],
    run: () => ({ shell: 'test -s health.txt' }),
  }),

  '/target/quality/health': target(['/package-manager/exec'], {
    intent: 'test',
    render(context, exec) {
      return {
        deps: [],
        run: ({ host }) => ({
          FROM: 'alpine:3.22',
          steps: [...context.files({ host }), ...runSteps(context.invocations(), exec)],
          IGNORE: [],
        }),
      }
    },
  }),
})
```

The target path supplies its Dagr facet and target name. A binding at `/target/quality/health`
becomes `quality:health`.

## Files and commands

Files are context-aware; commands are not.

A file renderer receives `{ intent, facet, host }` plus dependency values and returns one Dagr step
or nested arrays of steps. An empty array means "nothing to do". Any non-step value, including
`undefined` and `false`, is an error. A file binding may render `COPY`, an inline write, `CMD`, or any
other step.

A command renderer receives only dependency values and returns invocations: `{ tool }` for an
installed binary or `{ shell }` for a literal command line. A consumer decides how to materialize an
invocation:

- a container target maps it through `/package-manager/exec`;
- package.json scripts map it through `/package-manager/script`;
- another runner may choose another representation.

`runSteps(invocations, exec)` performs container materialization. Installation is not a
contribution; a target calls `/package-manager/install` when it creates a fresh image.

`for` is the intent gate. A target receives `/file/**` and `/command/**`, then asks for the values
matching its context:

- `context.files(overrides)` renders applicable file bindings;
- `context.invocations(overrides)` returns applicable invocations.

Files and commands default to `order: 0`. Equal orders retain graph key order. Use another numeric
order only where sequence is behavior.

## Requirements and versions

Tool requirements use `/requirement/**`. Independent features can own paths such as
`/requirement/typescript`, `/requirement/vitest`, and `/requirement/eslint`. Generated manifests,
compiler configuration, commands, and package-manager configuration consume `/requirement/**`.

`packages` contains names only. Versions come from `/version/catalog`, built from
`dagr.versions.yaml` plus the `versions` option passed to `typescript`. A required package with no
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

Capabilities such as `prettier()`, `biome()`, `vitest()`, `eslint()`, `typedoc()`, and `rollup()` add
their own file, command, requirement, and target paths. They do not register themselves with the
core recipe.

`sourceTarget({ intent, assets, export })` implements targets that copy local tarballs and source,
render files, install dependencies, run commands, and optionally export results. The target's graph
path supplies its name and facet.

`rollup({ bundleDirectory, strict })` adds `/target/ci/bundle` and supporting bindings. It consumes
`/output/layout` and `/package/slug`; a product that emits no JavaScript entry is rejected.

## Package managers

`npm()`, `pnpm()`, and `yarn()` are feature graphs. Each owns these replaceable semantic paths:

- `/package-manager/install-manifest`
- `/package-manager/exec`
- `/package-manager/script`
- `/package-manager/install`
- `/package-manager/pack`
- `/command/pack/package`
- `/file/package-manager`

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

  '/command/pack/package': command(['/package-manager/pack', '/package/slug'], {
    for: ['pack', 'publish'],
    run: (pack, slug) => ({ shell: pack(slug) }),
  }),

  '/file/package-manager': file([], {
    for: ['dev', 'typecheck', 'test', 'lint', 'docs', 'build'],
    render: () => writeText('/repo/bunfig.toml', '[install]\nexact = true\n'),
  }),
})
```

Local package dependencies arrive from sibling `ci:pack` targets as tarballs. Install rendering may
replace their manifest ranges with `file:` references. Pack and publish rendering restores public
ranges.
