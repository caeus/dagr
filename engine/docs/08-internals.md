# Internals

This page explains the current engine structure for contributors and for debugging behavior that
the authoring documentation does not cover.

## Source map

```text
src/
├── index.ts                    process entry point
├── wire.ts                     dependency composition and command dispatch
├── commands/index.ts           parsing and runners for run, list, pkg ls, and show
├── report/reporter.ts          progress and bounded failure output
├── sys/                        process execution, host detection, and disposal
├── pkg/
│   ├── schema.ts               index, target, recipe, step, and export schemas
│   ├── loader.ts               discovery, sandboxed modules, imports, and traversal
│   ├── mount-request.ts        mount request parsing and validation
│   ├── volume-registry.ts      root-owned identity and implementation policy
│   ├── builtins.ts             dagr:yaml and dagr:toml
│   └── sandbox.ts              restricted VM context
└── runner/
    ├── index.ts                addresses, dependency walk, cycles, and memoization
    ├── target-runner.ts        recipe evaluation and mounted COPY resolution
    ├── dockerfile-renderer.ts  recipe to Dockerfile text
    ├── docker-builder.ts       Buildx invocation and named build contexts
    ├── docker-copier.ts        stopped-container copies
    ├── docker-extractor.ts     EXPORT materialization
    ├── docker-inspector.ts     image WORKDIR inspection
    └── volume-materializer.ts  volume build, extraction, and cleanup
```

The engine's own build, tests, bundle, and runtime image are defined by
[`engine/dagr.index.js`](../dagr.index.js). Generated package-manager and compiler files are build
inputs produced by that graph, not committed configuration.

## Startup and command dispatch

`index.ts` calls `wire()`. `wire()` parses arguments with Optique, builds the dependency module,
shakes it to `commandRunner`, compiles it, and executes the selected command. An
`AsyncDisposeStack` owns temporary materialized-volume cleanup when execution fails.

`CompositeCommandRunner` delegates to four runners:

- `RunCommandRunner` builds requested targets and materializes their declared exports.
- `ListCommandRunner` recursively discovers source packages and prints their resolved dependency
  outlines.
- `PackageListCommandRunner` filters discovered packages to the current working directory and
  prints relative names.
- `ShowCommandRunner` loads a package, facet, or target and prints YAML without building an image.

`show` evaluates a target's `run()` function to obtain its recipe. Build definitions must therefore
remain deterministic even when no build is requested.

## Addresses

`FQT` carries a package, facet, and target as a value instead of passing an ambiguous string
through the engine. `FQT.parse()` expands dependency and command-line shorthands once, then the
runner uses the structured value.

Package names always begin with `//`. Mounted boundaries add another `//` inside the logical
package name. `packageLogicalPath()` removes only the leading root marker when translating a
source package to its repository directory.

## Discovery and loading

`RepositoryPackageLoader.loadAllPackages()` recursively walks the repository root. It skips
`.git`, continues below ordinary packages, and stops below directories containing
`dagr.mount.yaml` because discovery must not materialize volumes. A colocated `dagr.index.js`
remains independently discoverable. A package at the repository root does not hide nested packages.

`loadPackage()` resolves one exact logical package path. It walks each mount boundary in that path
without scanning unrelated directories. Package, index, module, and volume promises are cached for
the invocation, so concurrent requests share both successful work and failures. Volume promises
are keyed by root-defined volume ID, not by mount path.

A `dagr.index.js` file is evaluated as a `vm.SourceTextModule`. Its default export is validated by
`IndexDef`, and an invalid shape is reported with its logical package path. The removed `{ '/':
mountImplementation }` shape receives direct migration guidance.

JavaScript imports use the same VM context. JSON, YAML, and TOML imports become deeply frozen
`vm.SyntheticModule` values. The sandbox exposes standard JavaScript, `Buffer`, `dagr:yaml`, and
`dagr:toml`, but not Node filesystem, process, network, timer, or CommonJS APIs.

`node:vm` reduces accidental ambient access. It is not a security boundary, so repository source
and pinned images must still be trusted.

## Imports and mount boundaries

An import beginning with `//` resolves from the current source root. Each additional `//` crosses
a mount requested by `dagr.mount.yaml`, materializes its root-defined volume implementation, and
establishes a new source root.
Modules inside the mounted tree resolve their own leading `//` from that tree, not from the host
repository.

`import.meta.dagr.location` is derived from the current source root. A mounted component therefore
sees the same logical locations regardless of where a consuming repository mounts it.

The invocation root loads `.dagr/config.js` and `.dagr/volumes.yaml` the first time a mount is
traversed. `identifyVolume(request)` returns a string ID, and the matching volume implementation is
rendered and built as an image recipe using the invocation root as its build context. The
materializer inspects the image's final `WORKDIR` and copies that directory into temporary storage.
Re-entering the same volume ID through the active trace is a circular mount. Configuration found
inside mounted repositories is never consulted.

## Target execution

`buildRunner()` memoizes a `Promise<TargetResult>` by fully qualified target. Memoizing the promise
means two concurrent branches share one in-flight prerequisite. A separate trace detects cycles
and reports the complete dependency path.

For each target, the runner:

1. Loads the exact package.
2. Resolves and builds dependencies concurrently.
3. Creates `ctx.images` using the dependency strings exactly as authored.
4. Evaluates `run({ images, host })`.
5. Validates the returned recipe with `Run`.
6. Resolves mounted `COPY` sources.
7. Renders and builds the Docker image.

A source such as `tools//include/a.h` crosses the mount at `tools`. The runner materializes the
mount once, assigns it a generated BuildKit context name, and rewrites the rendered `COPY` to use
that named context. A `COPY` with an explicit `from` is left unchanged.

## Docker builds and tags

The builder writes a temporary Dockerfile, a matching `.dockerignore`, and an iid file, then runs:

```sh
docker buildx build --progress=plain --load \
  -t <tag> --iidfile <iidfile> -f <dockerfile> <package-context>
```

Mounted copy contexts add `--build-context <name>=<path>`. `--load` places the result in the Docker
daemon used by later targets, exports, and manual inspection.

The local tag is derived from the target address by replacing `:` with `-`, `/` with `_`, and
removing leading non-alphanumeric characters. For example, `//packages/ui:ci:build` becomes
`packages_ui-ci-build`. Tags are stable and unversioned; rebuilding replaces the tag while Docker
retains reusable layers.

The process runner streams output only in verbose mode and otherwise retains a bounded tail from
stdout and stderr. A failed command includes that tail, which keeps normal output quiet without
hiding the useful part of a failure.

## Exports

`runTarget()` returns an `EXPORT` map but never copies it. `RunCommandRunner` performs extraction
only for targets explicitly requested by the user, which prevents exports from becoming
transitive side effects. Direct exports from mounted package identities are rejected because they
cannot map unambiguously onto a host package directory.

Extraction uses `docker create`, `docker cp`, and `docker rm`; the temporary container is never
started. Replace versus merge behavior is determined by trailing slashes and is validated before
copying.

## Host and container paths

The Dagr process reads the repository at `/repo`, while the host Docker daemon knows the checkout
by its host path. The launcher passes both `REPO_ROOT` and `HOST_REPO_ROOT`; `WORKING_DIR` is
translated against the host root to find the current package. Docker build contexts and
`docker cp` destinations use paths visible inside the Dagr container.

The launcher mounts `/var/run/docker.sock`. Access to that socket is effectively root access to
the host. The VM sandbox limits what build-definition code can do directly, but the repository and
runtime image remain trusted inputs.

## Dependency composition

`wire.ts` uses `@caeus/wyr` to assemble the engine. Providers are immutable definitions; `shake()`
retains the command runner and its transitive dependencies, and `compile()` validates and eagerly
resolves that graph. The resulting container lookup is synchronous.

The composition root owns environment-derived paths, reporting, process execution, Docker
adapters, the package loader, target runner, and all four command runners. Lower-level runner and
package modules depend on those narrow capabilities rather than importing the composition root.
