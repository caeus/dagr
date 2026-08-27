# Internals

For contributors to dagr itself, and for anyone debugging behaviour that the authoring
docs don't explain.

## Source map

```
src/
├── index.ts                    entrypoint: wire().catch(reporter.failure)
├── wire.ts                     DI bindings + main()
├── report/reporter.ts          human-readable stderr reporter
├── sys/
│   ├── process-runner.ts       captured child processes + bounded output tails
│   ├── host-platform.ts        reads the real host os/arch/libc out of the env
│   └── dispose-stack.ts        LIFO finalizers (no external DI dependency)
├── commands/index.ts           arg parsing + one runner class per command
├── pkg/
│   ├── schema.ts               Zod schemas for IndexDef/MountDef/PackageDef/Run/Step
│   └── loader.ts               filesystem/source walk + vm sandbox evaluation
└── runner/
    ├── index.ts                FQT, TargetResult, buildRunner (graph walk + memo)
    ├── target-runner.ts        runTarget: one target → one image
    ├── dockerfile-renderer.ts  Run → Dockerfile text
    ├── docker-builder.ts       docker buildx build
    ├── docker-copier.ts        docker create + cp + rm for mounted trees
    ├── docker-inspector.ts     reads an image's configured WORKDIR
    ├── docker-extractor.ts     prepares EXPORT destinations and delegates to docker-copier
    └── mount-materializer.ts   mount build, extraction, memo, and symlink validation
```

Internal imports never use relative paths. `package.json` declares a `#*` subpath map, so every
module is referenced from the source root — `#report/reporter.js`, `#runner/index.js` — including
imports between siblings in the same directory. Keep the `.js` extension; the package is ESM and
`moduleResolution` is `NodeNext`.

Each Docker runner module owns the interface for its capability (`DockerImageBuilder`,
`DockerImageCopier`, and so on). `wire.ts` imports those ports and composes them; runner and
command modules never depend on the composition root.

The map points at `./dist/*`, and there is deliberately only one target. Tests are the subtle part:
they stay TypeScript and are run from `src/` by tsx, but their `#`-prefixed imports still resolve
to `dist/`, so they exercise the very modules the container runs. That is why `make test` depends
on `make build`. If tests resolved to `src/` while the entrypoint resolved to `dist/`, a wrong map
would pass every test and still fail on the first real invocation — not a hypothetical, it shipped
once in `9e567d2`.

Tests are never compiled and never shipped: `make build` and the `Dockerfile` both use
`tsconfig.build.json`, which excludes `src/**/*.test.ts`. The root `tsconfig.json` still includes
them so `make typecheck` covers them. The two configs keep separate `tsBuildInfoFile`s so their
incremental caches don't invalidate each other.

The `Dockerfile` additionally runs `dagr list` against an empty fixture right after `tsc`, so any
load-time breakage fails the image build rather than the first real invocation.

## The pipeline

```
argv ──► parseCmd ──► Cmd
                       │
         ┌─────────────┴──────────────┐
         ▼                            ▼
  RunCommandRunner            ListCommandRunner
         │                            │
   FQT.parse(cmd.fqt,           packageLoader.loadAllPackages()
     {pkg: currentPackage})     then topological sort → stdout
         │
         ▼
  buildRunner(packageLoader, deps, host)   ── memo: Map<string, Promise<TargetResult>>
         │
         ├─ packageLoader.loadPackage(fqt.pkg)
         │  for each dep, load its package and recurse with Promise.all
         ▼
  runTarget(fqt, target, depResults, loaded.context, deps, host)
         │
         ├─ tag       = fqt.toString() with : → -, / → _, leading non-alnum stripped
         ├─ packageDir = loaded.context
         ├─ images    = { <raw dep string>: <dep image tag> }
         ├─ runDef    = target.run({ images, host })
         ├─ content   = renderDockerfile(runDef)
         └─ build     = buildDockerImage(content, tag, packageDir, runDef.IGNORE)
         │
         ▼
  TargetResult { fqt, imageTag, imageDigest, export? }
         │
         ▼
  RunCommandRunner: if result.export, extractFromImage(imageTag, export, join(hostRoot, pkg))
```

Note the split of responsibility at the last step: `runTarget` returns the `EXPORT` map but
never acts on it. Extraction is done by `RunCommandRunner`, which is the only place that knows
the request was for *this* target specifically. That is what makes "only the invoked target
exports" fall out of the structure rather than needing a flag.

## Loading

`RepositoryPackageLoader` owns package, mount, index, and module caches for one invocation.
`loadPackage(logicalPath)` resolves one exact path without scanning siblings.
`loadAllPackages()` performs the conventional root and `packages/` scan used by `dagr list`.

Each physical source tree gets a `LoadContext` containing:

- `vmContext`, the one VM context shared by the invocation.
- `root`, the physical source root for `/` imports.
- `logicalRoot`, the mount path that produced that source.
- `trace`, the mount identities used for cycle detection.
- `cache`, keyed by logical source root and resolved module path.

Exact package resolution works as follows:

1. Split the logical package path on `//`.
2. Resolve the first segment directly from the host repository root.
3. Every non-final segment must contain a `/` index. Materialize it, append the boundary to
   the logical root, and continue from the extracted final `WORKDIR`.
4. Parse the final `dagr.index.js` as a normal package and return its definition plus physical
   build context.
5. Cache the promise by logical package path before awaiting it, so concurrent branches share
   both successful loads and failures.

Imports follow the same source-root model. `/lib/dagr.shared.js` stays within the importing
module's source tree. `/tools//dagr.shared.js` materializes the mount at `tools`, then links the
module with the mounted root as its new `/`. If that module imports `/c//dagr.next.js`, `c` is
resolved inside the mounted tree. Each module carries its destination `LoadContext`, so nested
imports never fall back to the original host root.

Indexes and JavaScript imports are `vm.SourceTextModule`s. JSON, YAML, and TOML imports become
`vm.SyntheticModule`s with deep-frozen default exports. `dagr:yaml` and `dagr:toml` are synthetic
modules exposing context-native wrappers around the runner's pinned serializers. The shared VM
context exposes no ambient Node capabilities and disables dynamic code generation. It does not
attempt to remove standard JavaScript globals or enforce purity. Each index receives a frozen,
null-prototype `import.meta.dagr` whose `location` is its canonical logical package location;
physical source paths are never exposed. An index's default export is parsed with
`IndexDef.safeParse`; on schema failure the package is silently skipped. Mount identities are
`<image digest>:<final workdir>` and are threaded through package and import resolution to detect
cycles.

That silent skip is the single biggest ergonomic wart in dagr. See
[11 — Troubleshooting](11-troubleshooting.md#my-package-doesnt-show-up-in-dagr-list).

## `FQT`

A value class, not a string alias, so it is parsed once and passed around structurally:

```ts
class FQT {
  constructor(readonly pkg: string, readonly facet: string, readonly target: string) {}
  toString(): string          // `//${pkg}:${facet}:${target}`
  toJSON(): string            // === toString(), so it serializes as a plain string
  static parse(raw: string, context?: { pkg: string; facet?: string }): FQT
}
```

`parse` splits on `:` and fills missing leading segments from `context`, throwing
`Package required...` or `Facet required...` when context is insufficient. `Runner` is
`(fqt: FQT) => Promise<TargetResult>` — it takes the parsed object, never a string, so no layer
re-parses what an earlier layer already parsed.

The field is `pkg`, not `package`, because `package` is a future-reserved word in strict mode
and ESM is always strict. It would be legal as a property but not as the constructor parameter
that a TS parameter property implies, so the abbreviation is uniform rather than half-applied.

## Graph walk and memoization

`buildRunner` closes over a `Map<string, Promise<TargetResult>>` keyed by the fully-qualified FQT
string. Because the *promise* is memoized rather than the result, two concurrent requests for
the same target share one in-flight build — the `memoizes` test asserts exactly one
`buildDockerImage` call for two parallel `runner()` invocations.

Before looking up each target, the runner asks `PackageLoader.loadPackage(fqt.pkg)`. A dependency
in another package therefore extends the loaded graph only when recursion reaches it.

Cycle detection uses an explicit `trace` array threaded through the recursion, so the error
message contains the full path rather than just "cycle detected". The memo and the trace are
independent: a diamond dependency hits the memo and is fine; a true cycle hits the trace and
throws.

## Image tag derivation

```ts
const tag = fqt.toString()
  .replace(/:/g, '-')
  .replace(/\//g, '_')
  .replace(/^[^a-zA-Z0-9]+/, '')
```

| FQT | Tag |
| --- | --- |
| `//packages/ui:ci:build` | `packages_ui-ci-build` |
| `//packages/base:ci:node-pnpm` | `packages_base-ci-node-pnpm` |
| `//:ci:deploy` | `ci-deploy` |

The leading-character strip removes the root marker: `//:ci:deploy` becomes `ci-deploy` rather
than a tag beginning with underscores.

Tags are **stable and unversioned**. Rebuilding a target overwrites the tag, and the previous
image becomes a dangling layer. `docker image prune` is your friend on a long-lived machine.
Because tags are deterministic, they are also predictable from outside dagr — handy for
`docker run packages_ui-ci-build` to poke at a result by hand.

## Building

`buildDockerImage(content, tag, contextPath, ignore)` writes to a temp directory:

- `<base>.Dockerfile` — the rendered content.
- `<base>.Dockerfile.dockerignore` — the target's `IGNORE` list, one entry per line, and
  nothing else. Docker looks for `<dockerfile>.dockerignore` when `-f` points outside the
  context, which is what lets a temp-file Dockerfile still carry ignore rules.
- `<base>.iid` — receives the image ID.

Then:

```sh
docker buildx build --progress=plain --load -t <tag> --iidfile <iid> -f <dockerfile> <contextPath>
```

`--load` is required so the built image lands in the local daemon's image store where the next
target's `FROM` and the extractor can find it. The digest in `TargetResult` is the trimmed
contents of the iidfile. All three temp files are removed in a `finally`.

`--progress=plain` makes BuildKit output line-oriented. `ProcessRunner` pipes stdout and stderr,
hands every complete line to `Reporter.processLine` — which prints it only under `--verbose` —
and retains a bounded 100-line tail per stream. The tail is what `ProcessExecutionError` carries,
so a quiet run can still explain a failure. Docker writes ordinary progress to stderr, so the
stream name is recorded as data and never treated as a severity.

## Extracting

```sh
docker create <imageTag>
docker cp <container>:<src> <dest>
docker rm <container>
```

One stopped container per entry in the `EXPORT` map, processed sequentially. Path syntax still
controls intent without inspecting the image: a source ending in `/` copies `<src>/.` into an
existing destination, while the no-slash form deletes the exact destination before `docker cp`.
A destination ending in `/` resolves to `<dest>/<basename(src)>`.

The extractor throws for a replace aimed at the package directory itself (`'.'` or `''`) and for
any destination escaping that directory. `Run`'s schema rejects both shapes too; runtime guards
remain because the failure mode is deleting files outside the intended export destination.

## Validating `run()` output

`PackageDef` is parsed when a `dagr.index.js` loads, but that only checks `deps` and that `run` is
a function — it cannot see what `run` *returns*, since the function is not called until build
time. So `runTarget` parses the result:

```ts
const parsed = Run.safeParse(target.run({ images, host }))
if (!parsed.success) throw new Error(`Invalid run definition for ${fqt}: ${parsed.error.message}`)
```

This is what makes the `Run` schema load-bearing rather than a type-level fiction. A missing
`IGNORE`, a misspelled step key, or an incoherent `EXPORT` pairing surfaces as a named error
against a specific FQT, before any Docker build starts — instead of a `TypeError` deep in the
builder.

## The DI container

`wire.ts` uses `@caeus/wyr`. `defaultModule` returns one immutable `Module({ ...providers })`, and
its third parameter lets tests replace the entire graph.

- `toValue(value)` provides a constant.
- `toFactory([deps], fn)` resolves the named dependencies and passes them positionally to a sync
  or async factory.
- `toClass([deps], Class)` does the same for a constructor.
- `.shake(['commandRunner'])` retains only that key and its transitive dependencies.
- `.compile()` validates and eagerly resolves the shaken graph. Missing, mismatched, and circular
  dependencies are rejected by Wyr's types at the compile call.
- The compiled container's `.get(key)` is synchronous because resolution already happened.
- `AsyncDisposeStack` is separate from Wyr. It runs finalizers LIFO in `wire`'s `finally`; mount
  storage registers its temporary-directory cleanup there.

The bindings in `wire.ts`:

| Key | Bound to |
| --- | --- |
| `root` | `REPO_ROOT`, or dagr's parent directory |
| `hostRoot` | `HOST_REPO_ROOT`, falling back to `root` |
| `mountRoot` | `MOUNT_ROOT`, falling back to a process-specific temporary directory |
| `currentPackage` | `relative(hostRoot, WORKING_DIR ?? hostRoot)` |
| `reporter` | human-readable progress and failure writer targeting stderr |
| `output` | command-result writer targeting stdout |
| `processRunner` | child-process runner capturing both streams and feeding the reporter |
| `dockerImageCopier` | stopped-container `docker cp` adapter |
| `mountMaterializer` | mount builder, inspector, copier, and validator |
| `packageLoader` | `RepositoryPackageLoader(root, mountMaterializer)` |
| `dockerfileRenderer` | `{ renderDockerfile }` |
| `dockerImageBuilder` | `{ buildDockerImage }` |
| `dockerImageExtractor` | `{ extractFromImage }` |
| `hostPlatform` | `hostPlatform(env)` |
| `runner` | `buildRunner(packageLoader, deps, hostPlatform)` |
| `listCommandRunner` | `ListCommandRunner(packageLoader)` |
| `runCommandRunner` | `RunCommandRunner(runner, extractor, root, currentPackage)` |
| `commandRunner` | `CompositeCommandRunner(runCommandRunner, listCommandRunner)` |

Target build contexts come from `LoadedPackage.context`, which may be a local directory or an
extracted mount. `EXPORT` destinations use the container-side repository root; direct exports from
mounted package identities are rejected. `docker cp` writes through the existing `/repo` bind
mount.

## Command dispatch

`CompositeCommandRunner` is the only place that switches on `cmd.command`. Each concrete runner
then takes the narrowest type it can:

```ts
export type Cmd = InferValue<typeof parser>
export type RunCmd = InferValue<typeof runCommand>

class RunCommandRunner  { execute(cmd: RunCmd): Promise<void> }
class ListCommandRunner { execute(): Promise<void> }
```

`RunCommandRunner` never re-checks the discriminant, and `ListCommandRunner` takes no argument
at all — because dispatch already established both facts. Adding a command means adding a
parser, a runner class, and one branch in the composite.

## The dagr image

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache docker-cli docker-cli-buildx && corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /dagr
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY src/ ./src/
COPY tsconfig.json tsconfig.build.json ./
RUN pnpm exec tsc -p tsconfig.build.json
RUN <smoke-run of `dagr list` against an empty fixture>
ENV REPO_ROOT=/repo
ENTRYPOINT ["node", "--experimental-vm-modules", "dist/index.js"]
```

This is the Dockerfile in *this* repository, which compiles from a local checkout. A repo that
consumes dagr writes a different one that clones this repository at a pinned SHA — see
[10 — Adopting in a new monorepo](10-adopting-in-a-new-monorepo.md).

The image carries the Docker CLI and buildx plugin but no daemon — `cli.sh` mounts the host
socket. Dependencies are installed before `src/` is copied, so editing dagr's source only
invalidates the `tsc` layer.

`--experimental-vm-modules` is what enables `vm.SourceTextModule`. Without it, the loader
throws immediately.
