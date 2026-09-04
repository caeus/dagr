# Concepts

dagr is a programmable build system for monorepos. Normal JavaScript defines the repository's
dependency graph, and Docker images represent executable targets and reusable results.

You ask dagr for one or more targets. dagr calculates the reachable graph, runs prerequisites first, runs independent branches concurrently, and reuses unchanged work.

Each target produces an image, so downstream targets can use completed work directly while Docker
provides isolation and caching.

## The four nouns

```text
package             a directory containing a dagr.index.js
  └── facet         a named group of targets
        └── target  a unit of work
```

- **Package** - a directory with a `dagr.index.js` file. Its name starts at the repository root,
  such as `//services/api` or `//libraries/common`. The root package is `//`.
- **Facet** - a named group of targets. dagr assigns no meaning to facet names. `ci` is a convention, not a keyword. Facet and target names use portable filename characters: `[A-Za-z0-9][A-Za-z0-9._-]*`.
- **Target** - a `{ deps, run }` pair. It declares which other targets it needs and how to perform one unit of work.
- **FQT** (fully-qualified target) - the address of a target, written `//package:facet:target`, for example `//services/api:ci:build`. The leading `//` anchors the address at the repository namespace root.

For example:

```sh
dagr run //services/api:ci:build
```

asks dagr for exactly one result. dagr follows that target's dependencies and ignores unrelated work elsewhere in the repository.

## The graph is code

A `dagr.index.js` exports the build model for one package.

Because it is JavaScript, the graph does not need to be written out literally. Targets can be generated from loops, functions, imported helpers, or richer repository-specific models.

```js
const commands = {
  format: './tools/check-format',
  test: './tools/test',
}

const checks = Object.fromEntries(
  Object.entries(commands).map(([name, command]) => [
    name,
    {
      deps: [],
      run: () => ({
        FROM: 'alpine:3.22',
        steps: [
          { WORKDIR: '/repo' },
          { COPY: { src: '.', dest: '/repo' } },
          { RUN: command },
        ],
        IGNORE: ['.git', 'out'],
      }),
    },
  ]),
)

export default {
  ci: {
    ...checks,
  },
}
```

Here two targets are calculated from one small model. A repository can define helpers that expand
its own concepts into concrete Dagr targets.

Dagr does not prescribe languages, frameworks, package managers, or repository shapes. The
repository owns that model.

## Dependencies define both order and composition

A target's `deps` define edges in the graph.

If target `B` depends on target `A`, dagr guarantees that `A` completes before `B` runs. `B` also receives the completed dependency results through `ctx.images`.

A dependency can therefore be used only for ordering, or it can become an input to the next target:

```js
run: ({ images }) => ({
  FROM: images.a,
  steps: [{ RUN: './build.sh' }],
})
```

or files can be copied from it into another environment:

```js
run: ({ images }) => ({
  FROM: 'alpine:3.22',
  steps: [
    {
      COPY: {
        from: images.a,
        src: '/out/artifact',
        dest: '/artifact',
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

The completed target is a Docker image. Dagr uses it to:

- continue one target from another;
- copy files between targets;
- isolate build environments;
- reuse Docker's persistent layer cache.

If files need to appear on the host, the directly requested target can declare `EXPORT`:

```js
run: () => ({
  FROM: 'alpine:3.22',
  steps: [
    { COPY: { src: '.', dest: '/repo' } },
    { RUN: 'cd /repo && ./build.sh' },
  ],
  IGNORE: ['.git', 'out'],
  EXPORT: { '/repo/dist': 'dist' },
})
```

Without `EXPORT`, the result can stay internal to the build graph.

## Mounted package trees

A `dagr.index.js` can also declare a mounted filesystem by global logical ID instead of declaring facets:

```js
// stacks/tools/dagr.index.js
export default {
  '/': 'github.com/acme/dagr-tools',
}
```

The root monorepo's `.dagr/config.js` exports `mount(id)`, which returns the image recipe for an ID.
The ID is filesystem identity, not an implementation or version. The root resolver is authoritative
for the whole composed monorepo, and all occurrences of the same ID share one mounted filesystem.

If that image's final `WORKDIR` contains `c/dagr.index.js`, `//` marks the mount boundary in its package address:

```text
//stacks/tools//c:ci:pack
```

`/` is an alternate index kind, not a special facet. It cannot coexist with facets.

A mount is resolved and materialized only when a requested target or import crosses its boundary.
`dagr list` leaves mounts opaque.

The boundary is part of package identity. `//stacks/tools/c` names a source package, while
`//stacks/tools//c` crosses the mount declared at `//stacks/tools`.

A package at the mounted `WORKDIR` root is addressed as:

```text
//stacks/tools//:facet:target
```

## Caching

There are two distinct kinds of reuse.

### Persistent reuse

Docker's layer cache handles reuse between dagr invocations.

If a target's rendered Dockerfile and build context are unchanged, `docker buildx build` can reuse the existing layers. This is why recipe ordering matters: stable work such as dependency installation should generally happen before volatile work such as copying source code.

Dagr deliberately does not add another persistent content-hash cache, fingerprint file, or remote artifact cache on top.

### Per-run reuse

Within one `dagr run`, a shared prerequisite is built once even when several requested targets
depend on it.

## Deterministic definitions

`dagr.index.js` files cannot read the host filesystem, network, processes, or environment.

Build definitions can still use JavaScript, imported helpers, committed data, templates, loops, and dagr's YAML and TOML stringifiers. The intention is that the graph is calculated from committed source rather than ambient machine state.

Definitions should therefore behave as pure functions of committed source. Pin mounted images when
their contents affect reproducibility.

See [Build-file environment and imports](04-sandbox-and-imports.md) for the available APIs.
