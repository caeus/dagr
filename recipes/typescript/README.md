# Composable TypeScript recipe

This recipe builds a Dagr index from one RDK graph. The graph contains ordinary calculated values and
three kinds of output contribution: files, commands, and targets.

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
package metadata. Generated manifests and tool configuration are file outputs.

## Recipe and builder

`recipe(features)` merges feature graphs and returns a callable builder. Calling it merges the
package declaration and compiles the final `index` binding.

```js
const stricter = nodeLibrary.with(companyPolicy())

nodeLibrary.graph.definitionOf('sourceDirectory')
```

Recipes use the exported generic builder:

```js
builder(init, run, graph)
```

The returned function performs `run(graph.merge(init(...args)))`. It exposes its immutable `graph`
and `with(feature)`, which returns another builder with the feature merged in.

## Contributions

`file`, `command`, and `target` return normal RDK definitions. Put them directly in a graph. Each
helper adds its collection tag automatically.

```js
const health = () => rdk.graph({
  message: rdk.value('healthy'),

  healthFile: file(['message'], {
    for: ['test'],
    render(ctx, message) {
      return writeText('/repo/health.txt', message)
    },
  }),

  healthCommand: command([], {
    for: ['test'],
    run: () => ({ shell: 'test -s health.txt' }),
  }),

  healthTarget: target(['exec'], {
    name: 'health',
    facet: 'ci',
    intent: 'test',
    render(ctx, exec) {
      return {
        deps: [],
        run: ({ host }) => ({
          FROM: 'alpine:3.22',
          steps: [...ctx.files({ host }), ...runSteps(ctx.invocations(), exec)],
          IGNORE: [],
        }),
      }
    },
  }),
})
```

**Files are context-aware; commands are not.** That asymmetry is deliberate, and it is the reason a
package.json script and a container step can come from one declaration.

A file renderer receives `{ intent, facet, host }` plus its dependency values, and returns one Dagr
step or nested arrays of steps. An empty array means "nothing to do"; anything that is not a step,
including `undefined` and `false`, is an error. A file is not limited to a file schema — it can
render `COPY`, an inline write, `CMD`, or any other step. What a tsconfig or a manifest contains
genuinely differs per intent, which is why files get a context.

A command renderer receives only its dependency values and returns **invocations**: `{ tool }` for a
binary the package installs, or `{ shell }` for a literal command line. It never sees a context, and
it never returns a step. Deciding how to run an invocation belongs to whoever materializes it:

- a container target maps it through `exec` — `pnpm exec tsc`;
- `package.json` `scripts` uses it bare, because the manager already resolves installed binaries;
- a Makefile or another task runner formats it however that runner expects.

`runSteps(invocations, exec)` is the container materialization. Installation is not a contribution:
only a fresh image needs it, so a target emits `install(host)` itself and no `order: -100` is needed
to win a race against tool commands.

`for` is the only intent gate: a contribution declares the intents it belongs to, and its renderer
then runs unconditionally. Do not re-check `ctx.intent` to opt back out. A target chooses its default
`intent` and `facet`, then asks for what it needs:

- `ctx.files(overrides)` renders every applicable file contribution.
- `ctx.invocations(overrides)` collects the intent's invocations, in contributed order.

Applicable contributions extend a target without modifying it. Contributions default to `order: 0`;
use a smaller or larger number only where sequence is real behavior. Ordering means different things
per materialization: separate steps in an image, `&&`-joined in one script.

Tool requirements remain ordinary graph values. `requirement({ for, packages, types, allowBuilds })`
creates one such value for open feature composition. Commands depend on their requirement nodes, and
generated manifests, compiler configuration, and manager files consume the same nodes. Neither the
generated command nor a generated file becomes canonical truth.

`packages` names packages; it never pins them. Every version comes from one catalog,
`dagr.versions.yaml`, which `typescript({ versions })` overrides per repository. A named package with
no catalog entry and no override is an error, so a feature cannot smuggle in a second pin.

## Targets that build from source

Nine of the built-in targets do the same thing: copy local tarballs, copy the source tree, then
render every file and command the context contributes. `sourceTarget({ name, facet, intent, assets,
export })` is that target, so a feature contributes one line and only its differences are visible.
Targets that build from another image instead — the `pack` targets — stay explicit.

## Targets and index

Targets are contributions with a local `name`, `facet`, `intent`, and renderer. There is no facet
declaration or target registry. The `index` binding only:

1. collects target contributions;
2. groups them by facet;
3. rejects duplicate names within a facet;
4. rejects a sibling dependency no contribution owns;
5. returns the Dagr index.

Dagr resolves a bare `"build"` against the depending target's own facet and `"ci:build"` against its
package, so both name a sibling the index must own. Step 4 is what makes a rename fail while the
graph compiles rather than while a container builds; write either form as a plain string. Only a full
`"//package:facet:target"` escapes the check, because it belongs to someone else.

The built-in library composition contributes direct `ci:typecheck`, `ci:build`, `ci:test`, `ci:lint`,
`ci:docs`, `ci:pack`, and `publish:pack` targets when their corresponding features are present. It
does not generate intermediate config or install targets.

## Ordinary graph values

Facts and shared calculations stay ordinary. `sourceDirectory`, `runtimeKind`, `outputLayout`,
`localPackages`, and the package-manager command transform are examples. Context is introduced only
when an output is rendered, so the graph is never copied or lifted per intent.

Replace a convention by merging a normal binding:

```js
const fromSource = nodeLibrary.with(rdk.graph({
  sourceDirectory: rdk.value('source'),
}))
```

## Products and capabilities

Choose one product graph:

- `library()`
- `cloudflareWorker()`
- `viteReact()`

Capabilities such as `prettier()`, `biome()`, `vitest()`, `eslint()`, `typedoc()`, and `rollup()` add
their own file, command, and target contributions. They do not register themselves with the core
recipe.

`rollup({ bundleDirectory, strict })` bundles a compiled library into one file and contributes
`ci:bundle`. It configures itself from facts that already exist — `outputLayout.runtimeFile` is the
input, `slug` names the output — so only the destination directory is an option. `strict` escalates
bundler warnings to errors. It needs a product that emits JavaScript, and says so if given one that
does not.

## Package managers

`npm()`, `pnpm()`, and `yarn()` are feature graphs. Each supplies four ordinary functions — `install`,
`exec`, `script`, and `pack` — plus `installManifest`, a `packCommand`, and a `packageManagerFile`.
`exec` and `script` are the two ways an invocation reaches a shell: through the manager in an image,
and bare in a manifest script. Because the bindings have the same names, normal right-biased graph
merging makes the last manager complete. The base image does not imply a manager.

A custom manager is just another graph with the same bindings and contributions:

```js
const bun = () => rdk.graph({
  installManifest: rdk.value(fileTarballs),
  install: rdk.value(() => 'bun install'),
  exec: rdk.value(invocation => `bun x ${invocation}`),
  script: rdk.value(invocation => invocation),
  pack: rdk.value(slug => `bun pm pack --destination /out --filename ${slug}.tgz`),

  packCommand: command(['pack', 'slug'], {
    for: ['pack', 'publish'],
    run: (pack, slug) => ({ shell: pack(slug) }),
  }),

  packageManagerFile: file([], {
    for: ['dev', 'typecheck', 'test', 'lint', 'docs', 'build'],
    render: () => writeText('/repo/bunfig.toml', '[install]\nexact = true\n'),
  }),
})
```

`install` receives the host platform where one is known, so a dev install can narrow to the host's
os and cpu while a CI image installs for its own platform.

No core modification or package-manager registration is required.
