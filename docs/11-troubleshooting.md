# Troubleshooting

## My package doesn't show up in `dagr list`

This is the failure mode you will hit most, and it is quiet by design-accident rather than by
design. `loadPackage` runs the package's default export through `PackageDef.safeParse` and, on
failure, **returns `null` and skips the package with no diagnostic**. `dagr list` then simply
omits it, and `dagr run` reports `Unknown target`.

Causes, roughly in order of likelihood:

- **A misspelled or unknown key in a `Step`.** Every step variant is `.strict()`, so
  `{ RUNN: '...' }`, `{ WORKIDR: '...' }`, or `{ COPY: { src, dst } }` (should be `dest`)
  fails validation. One bad step invalidates the entire package.
- **A missing `deps`.** Required, with no default.
- **`run` is not a function.** `run: { FROM: ..., steps: [] }` — a common slip — fails the
  `z.custom<RunFn>` check.
- **A helper returned `undefined`.** If a factory in `stacks/` forgets a `return`, or a
  `writeJson(...)` call is left off a step list, the resulting `undefined` fails the union.
- **`deps` contains non-strings.** It must be `string[]`; an accidental nested array or object
  fails.
- **The default export is missing entirely** — e.g. `export const ci = {...}` instead of
  `export default { ci: {...} }`.

Note that `PackageDef` is a `Record<string, FacetDef>` with no known keys, so the error is never
about facet names — those can be anything.

**How to find it:** bisect. Comment out targets until the package reappears in `dagr list`, then
narrow to the step. If you want a real error message, temporarily change `loader.ts` to throw
instead of returning `null`:

```ts
if (!result.success) throw new Error(`${filePath}: ${result.error}`)
return deepFreeze(result.data)
```

Zod's error is precise about which key in which step failed.

Note that only the *package* shape is checked at load time. What `run()` returns is validated
separately, at build time — see below.

## `Invalid run definition for <fqt>: …`

Raised when `run()` returns something `Run` rejects: a missing `IGNORE` or `steps`, a misspelled
step key, an incoherent `EXPORT` pairing. Unlike a bad package shape this is **loud and names the
target**, because it happens in `runTarget` after the function is actually called.

The distinction matters when you're hunting a problem: a package missing from `dagr list` is a
`dagr.index.js`-shape failure, while a target that fails the moment you run it is a `run()`-output
failure.

## `Dagr imports must start with /, got: <specifier>`

You used a bare or relative import. Every import in a `dagr.*.js` file must start with `/` and be
root-relative, including imports between files in the same directory.
`import { x } from './dagr.sibling.js'` must be `import { x } from '/stacks/dagr.sibling.js'`.

## `Unknown target: <fqt>`

Either the package failed to load (see above), or the FQT doesn't resolve to what you think.
Run `dagr list` and compare — it prints deps fully expanded, which is usually enough to spot the
mismatch. Common cases:

- You omitted the package segment but were not standing in that package's directory.
- You are at the repo root, where no package is inferred at all — fully qualify the FQT, and
  remember the root package is named `.` (`dagr run .#ci#deploy`).
- The facet is not `ci` (nothing forces it to be).

## `Facet required when only target is provided: <name>`

You passed a bare target name on the command line. Only the package is inferred from your
working directory; the facet never is.

```sh
dagr run build       # ✗
dagr run ci#build    # ✓
```

Inside a `deps` array, however, a bare name *does* work — there the current facet is known.

## `Circular dependency: a -> b -> a`

The path in the message is the actual cycle. Note this is raised at run time, not load time, so
`dagr list` will not warn you about it.

## `ENOENT ... /repo/packages`

The loader reads `packages/` unconditionally. Create the directory, even if it is empty.

## `docker: 'buildx' is not a docker command`

The dagr image installs `docker-cli-buildx`, so if you see this, the CLI in the container
is talking to a daemon that predates buildx, or the plugin failed to install. Upgrade Docker on
the host.

## `Cannot find module` / `SourceTextModule is not a constructor`

`--experimental-vm-modules` is missing. The `Dockerfile` ENTRYPOINT includes it; if you are
running `src/index.ts` directly for development, you need it too:

```sh
node --experimental-vm-modules --import tsx/esm src/index.ts list
```

## A `RUN` step that writes a file fails with "no such file or directory"

The target directory doesn't exist. Docker's `WORKDIR` creates directories; shell redirection
does not. Put `{ WORKDIR: '/repo' }` before any file-writing step. See
[03 — Ordering gotcha](03-authoring-dagr-index-js.md#ordering-gotcha-workdir-creates-directories).

## A generated file's contents are mangled or the build fails on quoting

Don't interpolate content into a shell command. Base64-encode on the host and decode in the
container:

```js
{ RUN: `echo "${Buffer.from(content).toString('base64')}" | base64 -d > ${path}` }
```

Newlines, quotes, `$`, and backticks all break naive `printf`/`echo` approaches. This is what
`Buffer` is injected into the sandbox for.

## `EXPORT` produced nothing

Three possibilities, in order:

1. **You didn't invoke that target directly.** Only the target named on the command line
   materializes its `EXPORT`; transitive deps do not. Run the target itself.
2. **The image has no shell.** Extraction runs `sh -c 'mkdir … && cp -a …'` inside the image, so
   it needs `sh`, `mkdir`, `cp`, and `dirname`. `scratch` and distroless images cannot be
   exported from.
3. **The bind mount resolved to the wrong filesystem.** Extraction mounts a *host* path,
   because the daemon resolves `-v`. If `HOST_REPO_ROOT` is wrong — or the daemon is genuinely
   remote — the copy succeeds into a directory you cannot see, with no error. See
   [09 — Docker-in-Docker](09-docker-in-docker.md).

## Exported `node_modules` don't work on my machine

They were installed in a Linux container. Packages with platform-gated binaries (rollup,
esbuild, swc, sharp) resolved to Linux artifacts, so a macOS or Windows host fails with missing
optional-dependency errors. Use a local install for host-side tooling and treat the exported
tree as editor metadata only. See
[05](05-deps-and-exports.md#exported-node_modules-are-linux-binaries).

## Everything rebuilds every time

Something volatile is early in your step list. Check for:

- `COPY src` before the dependency install — invert it.
- A generated file whose contents are not stable across runs (a timestamp, a random value, or
  key ordering that isn't deterministic). Any change to a written file invalidates that layer
  and all later ones.
- A dep target that itself rebuilds, since a changed `FROM` invalidates everything downstream.

Read the streamed build output: Docker prints `CACHED` for reused layers, so the first
non-cached line is your culprit.

## Old images piling up

Tags are stable and unversioned, so each rebuild orphans the previous image.

```sh
docker image prune          # dangling layers
docker images | grep -E '^(packages_|ci-)'
```

dagr never deletes images on its own.
