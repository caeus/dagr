# Internals

For contributors to dagr itself, and for anyone debugging behaviour that the authoring
docs don't explain.

## Source map

```
src/
├── index.ts                    entrypoint: main(argv, env).catch(console.error)
├── wire.ts                     DI bindings + main()
├── di-container.ts             the container (no external DI dependency)
├── commands/index.ts           arg parsing + one runner class per command
├── pkg/
│   ├── schema.ts               Zod schemas for PackageDef/FacetDef/TargetDef/Run/Step
│   └── loader.ts               filesystem walk + vm sandbox evaluation
└── runner/
    ├── index.ts                FQT, TargetResult, buildRunner (graph walk + memo)
    ├── target-runner.ts        runTarget: one target → one image
    ├── dockerfile-renderer.ts  Run → Dockerfile text
    ├── docker-builder.ts       docker buildx build
    └── docker-extractor.ts     docker run + bind mount to pull files out
```

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

`loadPackages(root)` creates one `LoadContext` — `{ root, context, cache }` — for the whole
session:

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
4. The marker is linked, evaluated, and its `default` export run through
   `PackageDef.safeParse`.
5. On success the parsed value is deep-frozen and stored. **On failure `null` is returned and
   the package is skipped with no diagnostic.**
6. The resulting `Map` is `Object.freeze`d and returned as a `ReadonlyMap`.

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
docker buildx build --load -t <tag> --iidfile <iid> -f <dockerfile> <contextPath>
```

`--load` is required so the built image lands in the local daemon's image store where the next
target's `FROM` and the extractor can find it. The digest in `TargetResult` is the trimmed
contents of the iidfile. All three temp files are removed in a `finally`.

The subprocess uses `stdio: 'inherit'`, so Docker's output is your output — no buffering, no
swallowed error messages.

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

`src/di-container.ts` is a small, dependency-free async container. It exists so that
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
| `currentPackage` | `relative(hostRoot, WORKING_DIR ?? hostRoot)` |
| `packageLoader` | `{ loadPackages }` |
| `packages` | `packageLoader.loadPackages(root)` |
| `dockerfileRenderer` | `{ renderDockerfile }` |
| `dockerImageBuilder` | `{ buildDockerImage }` |
| `dockerImageExtractor` | `{ extractFromImage }` |
| `hostPlatform` | `hostPlatform(env)` |
| `runner` | `buildRunner(root, packages, { renderDockerfile, buildDockerImage }, hostPlatform)` |
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
COPY tsconfig.json ./
RUN pnpm exec tsc
ENV REPO_ROOT=/repo
ENTRYPOINT ["node", "--experimental-vm-modules", "dist/index.js"]
```

The image carries the Docker CLI and buildx plugin but no daemon — `cli.sh` mounts the host
socket. Dependencies are installed before `src/` is copied, so editing dagr's source only
invalidates the `tsc` layer.

`--experimental-vm-modules` is what enables `vm.SourceTextModule`. Without it, the loader
throws immediately.
