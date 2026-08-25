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
    ├── docker-inspector.ts     reads an image's configured WORKDIR
    ├── docker-extractor.ts     docker run + bind mount to pull files out
    └── mount-materializer.ts   mount build, extraction, memo, and symlink validation
```

Internal imports never use relative paths. `package.json` declares a `#*` subpath map, so every
module is referenced from the source root — `#report/reporter.js`, `#runner/index.js` — including
imports between siblings in the same directory. Keep the `.js` extension; the package is ESM and
`moduleResolution` is `NodeNext`.

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
   FQT.parse(cmd.fqt,           topological sort of
     {pkg: currentPackage})     the loaded graph → stdout
         │
         ▼
  buildRunner(root, packages, deps, host)   ── memo: Map<string, Promise<TargetResult>>
         │
         │  for each dep, recursively (Promise.all), with a cycle trace
         ▼
  runTarget(fqt, target, depResults, root, deps, host)
         │
         ├─ tag       = fqt.toString() with # → -, / → _, leading non-alnum stripped
         ├─ packageDir = join(root, fqt.pkg)
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

`loadPackages(root, mountMaterializer)` creates a shared VM context and module cache. Each
physical source tree gets a `LoadContext` whose `root` is that source's import root:

- `context` is a single `vm.createContext(Object.assign(Object.create(null), { Buffer }))`.
- `cache` is a `Map<resolvedPath, vm.Module>` shared by every root-relative import in the repo.

Then:

1. `readdir(root)`. If a non-directory entry named `dagr.index.js` exists, load it as package `.`.
2. `walk(root/packages)`. For each directory: if it contains a `dagr.index.js`, load it under
   `relative(root, dir)` and **return without descending**. Otherwise recurse into all
   subdirectories in parallel.
3. Each marker becomes a `vm.SourceTextModule`. Its imports are resolved from the monorepo
   root and restricted to `dagr.*.js`, `dagr.*.json`, `dagr.*.yaml`, and `dagr.*.toml` files.
   JavaScript imports become `vm.SourceTextModule`s. Parsed data imports become
   `vm.SyntheticModule`s with a deep-frozen default export.
4. The marker is linked, evaluated, and its `default` export run through `IndexDef.safeParse`.
   A normal package is stored. A `#mount` is built, its final `WORKDIR` is extracted, and the
   walk resumes after appending a `//` boundary to the logical package path, using the extracted
   tree as the physical and import root.
5. On success the parsed value is deep-frozen and stored. **On failure `null` is returned and
   the package is skipped with no diagnostic.**
6. Mount identities are `<image digest>:<final workdir>` and are threaded through the recursive
   walk to detect mount cycles. Equivalent mount results share one extraction per invocation.
7. The loader returns frozen `definitions` and `contexts` maps. The first maps logical package
   IDs to definitions; the second maps the same IDs to their local or extracted physical build
   contexts.

That silent skip in step 5 is the single biggest ergonomic wart in dagr. See
[11 — Troubleshooting](11-troubleshooting.md#my-package-doesnt-show-up-in-dagr-list).

## `FQT`

A value class, not a string alias, so it is parsed once and passed around structurally:

```ts
class FQT {
  constructor(readonly pkg: string, readonly facet: string, readonly target: string) {}
  toString(): string          // `${pkg}#${facet}#${target}`
  toJSON(): string            // === toString(), so it serializes as a plain string
  static parse(raw: string, context?: { pkg: string; facet?: string }): FQT
}
```

`parse` splits on `#` and fills missing leading segments from `context`, throwing
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

Cycle detection uses an explicit `trace` array threaded through the recursion, so the error
message contains the full path rather than just "cycle detected". The memo and the trace are
independent: a diamond dependency hits the memo and is fine; a true cycle hits the trace and
throws.

## Image tag derivation

```ts
const tag = fqt.toString()
  .replace(/#/g, '-')
  .replace(/\//g, '_')
  .replace(/^[^a-zA-Z0-9]+/, '')
```

| FQT | Tag |
| --- | --- |
| `packages/ui#ci#build` | `packages_ui-ci-build` |
| `packages/base#ci#node-pnpm` | `packages_base-ci-node-pnpm` |
| `.#ci#deploy` | `ci-deploy` |

The leading-character strip exists for the root package: `.#ci#deploy` would otherwise become
`.-ci-deploy`, and Docker rejects a tag starting with `.`.

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
docker run --rm -v <destDir>:/host-out <imageTag> \
  # source ends in "/" — merge contents, delete nothing
  sh -c 'mkdir -p "<dest>" && cp -a "<src>"/. "<dest>"/'

  # otherwise — the node becomes <dest> exactly, replacing whatever was there
  sh -c 'mkdir -p "$(dirname "<dest>")" && rm -rf "<dest>" && cp -a "<src>" "<dest>"'
```

One container per entry in the `EXPORT` map, run sequentially. Which of the two scripts runs is
decided **entirely by the path syntax** — `copyScript` never inspects the image. That is why
files and directories need no separate handling: `cp -a` copies either to an exact destination.
A destination ending in `/` resolves to `<dest>/<basename(src)>`.

`copyScript` throws for a replace aimed at the package directory itself (`'.'` or `''`), since
that would `rm -rf` the bind mount. `Run`'s schema rejects the same shape, so it normally never
reaches here; the check is duplicated because the failure mode is destroying a working tree.

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

`src/sys/dispose-stack.ts` is a small, dependency-free async container. It exists so that
`main`'s third parameter can swap the entire object graph in tests.

- `createKey<T>(description)` returns a branded `symbol`. The brand is phantom
  (`[BRAND]?: () => T`), so keys carry their value type without any runtime cost, and
  `container.get(key)` is typed with no casts at the call site.
- `Module` is immutable. `.bind(key)` returns a slot; `.toValue`/`.toFun`/`.toClass` each
  return a **new** `Module` with the binding added, which is why `defaultModule` reads as one
  chained expression.
- `toFun([deps], fn)` and `toClass([deps], Cls)` are typed with a recursive `DerefMany` mapped
  tuple, so the dependency key array and the function's parameter list are checked positionally.
  Reorder the keys and it stops compiling.
- `Container.get` is async, memoizes the *promise* per key, resolves dependencies with
  `Promise.all`, and detects cycles with a trace — the same shape as the target runner.
- `AsyncDisposeStack` collects finalizers and runs them LIFO in `main`'s `finally`. Nothing
  registers one today; it is there so a binding that opens a resource has somewhere to put its
  teardown.

The bindings in `wire.ts`:

| Key | Bound to |
| --- | --- |
| `root` | `REPO_ROOT`, or dagr's parent directory |
| `hostRoot` | `HOST_REPO_ROOT`, falling back to `root` |
| `mountRoot` | `MOUNT_ROOT`, falling back to `<root>/.dagr-mounts` |
| `hostMountRoot` | `HOST_MOUNT_ROOT`, falling back to `mountRoot` |
| `currentPackage` | `relative(hostRoot, WORKING_DIR ?? hostRoot)` |
| `reporter` | human-readable progress and failure writer targeting stderr |
| `output` | command-result writer targeting stdout |
| `processRunner` | child-process runner capturing both streams and feeding the reporter |
| `mountMaterializer` | mount builder, inspector, extractor, and validator |
| `packageLoader` | `{ loadPackages(root, mountMaterializer) }` |
| `loadedPackages` | `packageLoader.loadPackages(root)` |
| `packages` | `loadedPackages.definitions` |
| `packageContexts` | `loadedPackages.contexts` |
| `dockerfileRenderer` | `{ renderDockerfile }` |
| `dockerImageBuilder` | `{ buildDockerImage }` |
| `dockerImageExtractor` | `{ extractFromImage }` |
| `hostPlatform` | `hostPlatform(env)` |
| `runner` | `buildRunner(root, packages, deps, hostPlatform, packageContexts)` |
| `listCommandRunner` | `ListCommandRunner(packages)` |
| `runCommandRunner` | `RunCommandRunner(runner, extractor, hostRoot, currentPackage)` |
| `commandRunner` | `CompositeCommandRunner(runCommandRunner, listCommandRunner)` |

Note `runner` gets `root` (container-side, for build contexts) while `runCommandRunner` gets
`hostRoot` (host-side, for bind mounts). That asymmetry is the whole subject of
[09 — Docker-in-Docker](09-docker-in-docker.md).

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
