# Concepts

dagr is a programmable build system for monorepos.

The core idea is not Docker. The core idea is that your repository's build is a dependency graph, and that graph is produced by normal JavaScript instead of being repeated across scripts, CI files, and tool-specific configuration.

You ask dagr for one or more targets. dagr calculates the reachable graph, runs prerequisites first, runs independent branches concurrently, and reuses unchanged work.

Docker is how dagr executes and composes that work. It is an implementation mechanism that gives dagr isolated environments, composable results, and persistent caching without inventing separate systems for each.

## The four nouns

```text
package             a directory containing a dagr.index.js
  └── facet         a named group of targets
        └── target  a unit of work
```

- **Package** - a directory with a `dagr.index.js` file. Its name is its path relative to the repository root, such as `packages/ui` or `packages/common`. The repository root can itself be a package; its name is `.`.
- **Facet** - a named group of targets. dagr assigns no meaning to facet names. `ci` is a convention, not a keyword. Facet and target names use portable filename characters: `[A-Za-z0-9][A-Za-z0-9._-]*`.
- **Target** - a `{ deps, run }` pair. It declares which other targets it needs and how to perform one unit of work.
- **FQT** (fully-qualified target) - the address of a target, written `//package:facet:target`, for example `//packages/ui:ci:build`. The leading `//` anchors the address at the repository namespace root.

For example:

```sh
dagr run //packages/ui:ci:build
```

asks dagr for exactly one result. dagr follows that target's dependencies and ignores unrelated work elsewhere in the repository.

## The graph is code

A `dagr.index.js` exports the build model for one package.

Because it is JavaScript, the graph does not need to be written out literally. Targets can be generated from loops, functions, imported helpers, or richer repository-specific models.

```js
const commands = {
  lint: 'pnpm lint',
  typecheck: 'pnpm exec tsc --noEmit',
  test: 'pnpm test',
}

const checks = Object.fromEntries(
  Object.entries(commands).map(([name, command]) => [
    name,
    {
      deps: ['install'],
      run: ({ images }) => ({
        FROM: images.install,
        steps: [
          { COPY: { src: 'src', dest: '/repo/src' } },
          { RUN: command },
        ],
        IGNORE: ['node_modules', '.git'],
      }),
    },
  ]),
)

export default {
  ci: {
    install: {
      deps: [],
      run: () => ({
        FROM: 'node:22-alpine',
        steps: [
          { WORKDIR: '/repo' },
          { COPY: { src: 'package.json', dest: '/repo/package.json' } },
          { RUN: 'pnpm install' },
        ],
        IGNORE: ['node_modules', '.git'],
      }),
    },
    ...checks,
  },
}
```

Here three targets are calculated from one small model. A repository can go further and define helpers such as `nodePackage()`, `library()`, or `service()` that expand its own concepts into concrete dagr targets.

dagr does not need built-in knowledge of Node packages, Rust crates, applications, deployment bundles, or any other repository shape. The repository owns that model.

## Dependencies define both order and composition

A target's `deps` define edges in the graph.

If target `B` depends on target `A`, dagr guarantees that `A` completes before `B` runs. `B` also receives the completed dependency results through `ctx.images`.

A dependency can therefore be used only for ordering, or it can become an input to the next target:

```js
run: ({ images }) => ({
  FROM: images.a,
  steps: [{ RUN: 'pnpm build' }],
})
```

or files can be copied from it into another environment:

```js
run: ({ images }) => ({
  FROM: 'node:22-alpine',
  steps: [
    {
      COPY: {
        from: images.a,
        src: '/out/thing.tgz',
        dest: '/thing.tgz',
      },
    },
  ],
})
```

This is where Docker becomes useful to the model: dagr can make one target's completed state directly available to another without a separate artifact protocol.

## Target execution

A target's `run` function returns a short Dockerfile-like recipe:

```js
{
  FROM,
  steps,
  IGNORE,
  EXPORT?,
}
```

dagr renders that recipe, builds it, and internally represents the completed target as a Docker image.

That image is not the user-facing abstraction. It is the execution result dagr uses to:

- continue one target from another;
- copy files between targets;
- isolate build environments;
- reuse Docker's persistent layer cache.

If files need to appear on the host, the directly requested target can declare `EXPORT`:

```js
run: () => ({
  FROM: 'node:22-alpine',
  steps: [
    { COPY: { src: '.', dest: '/repo' } },
    { RUN: 'cd /repo && pnpm build' },
  ],
  IGNORE: ['node_modules', '.git'],
  EXPORT: { '/repo/dist': 'dist' },
})
```

Without `EXPORT`, the result can stay internal to the build graph.

## Mounted package trees

A `dagr.index.js` can also replace its directory with the final working directory of another built image instead of declaring facets:

```js
// packages/tools/dagr.index.js
export default {
  '/': {
    FROM: 'ghcr.io/acme/dagr-tools:1',
    steps: [],
    IGNORE: [],
  },
}
```

If that image's final `WORKDIR` contains `c/dagr.index.js`, `//` marks the mount boundary in its package address:

```text
//packages/tools//c:ci:pack
```

`/` is an alternate index kind, not a special facet. It cannot coexist with facets, has no `deps`, and cannot declare `EXPORT`.

A mount is materialized only when a requested target or import crosses its boundary. Nested mounts work, and cycles by resulting image identity are rejected.

The boundary is part of package identity. `packages/tools/c` refers to a normal repository path, while `packages/tools//c` crosses the mount declared at `packages/tools`.

A package at the mounted `WORKDIR` root is addressed as:

```text
//packages/tools//:facet:target
```

Mounted trees are private temporary inputs. They do not modify the repository and disappear when the dagr invocation exits.

Running a mounted target directly with an `EXPORT` is rejected because a host filesystem cannot preserve the `//` mount boundary unambiguously.

## Caching

There are two distinct kinds of reuse.

### Persistent reuse

Docker's layer cache handles reuse between dagr invocations.

If a target's rendered Dockerfile and build context are unchanged, `docker buildx build` can reuse the existing layers. This is why recipe ordering matters: stable work such as dependency installation should generally happen before volatile work such as copying source code.

Dagr deliberately does not add another persistent content-hash cache, fingerprint file, or remote artifact cache on top.

### Per-run reuse

Within one `dagr run`, dagr memoizes targets by FQT. If five requested targets depend on the same prerequisite, that prerequisite is built once.

Package loading is memoized similarly, so concurrent branches evaluate or materialize the same logical package source once per invocation.

## Determinism and the sandbox

`dagr.index.js` files are evaluated in a `node:vm` context with no filesystem access, network access, or `process`. Dynamic code generation is disabled.

Build definitions can still use JavaScript, imported helpers, committed data, templates, loops, and dagr's YAML and TOML stringifiers. The intention is that the graph is calculated from committed source rather than ambient machine state.

Standard JavaScript globals such as `Date`, `Math.random`, and `Intl` remain available, so purity is a contract rather than something the sandbox can prove.

Each local index should therefore behave as a pure function of its source. Mounted indexes additionally come from the selected image, so pin `FROM` by digest when graph reproducibility depends on that mounted content.

See [The sandbox and imports](04-sandbox-and-imports.md) for the exact execution rules.

## What dagr deliberately does not do

- **No built-in test runner, linter, compiler, or package manager integration.** A target simply runs the tools your repository already uses.
- **No repository-specific package model.** dagr provides targets and dependencies; your JavaScript defines concepts such as libraries, applications, or services.
- **No watch mode.** Interactive development stays with the native development tools. dagr is aimed at reproducible build work.
- **No persistent scheduler state.** Independent dependencies run concurrently during an invocation; dagr does not maintain a separate distributed scheduler.
- **No versioning or publishing system.** Those remain normal build targets composed from existing tools.

The intended split is simple: **your repository defines the build graph; dagr executes it.** Docker is one of the reasons that execution stays small and composable, but it is not the thing the graph is modeling.