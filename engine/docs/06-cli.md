# CLI reference

```
dagr run [-v|--verbose] <fqt> [<fqt>...]
dagr list
dagr help [<command>]
dagr --help
```

Argument parsing uses [`@optique`](https://github.com/dahlia/optique), so unknown arguments produce
a usage error rather than being ignored. Help is opt-in in optique and this CLI enables both forms,
so `dagr --help` lists the commands and `dagr help run` documents one of them.

## `dagr run <fqt> [<fqt>...]`

Builds one or more targets and every transitive dependency, then materializes each target's
own `EXPORT` map if it has one. Requested targets run concurrently and share one dependency
cache, so a common dependency builds only once.

```sh
dagr run //packages/ui:ci:build
dagr run ci:build          # package inferred from cwd
dagr run //packages/common:ci:test //packages/ui:ci:test
```

The FQT may omit the package segment, which is then taken from your working directory. The
facet can never be omitted on the command line. See
[05 — Reference shorthands](05-deps-and-exports.md#reference-shorthands).

What happens, in order:

1. The requested target's package path is loaded directly. No repository scan happens.
2. The target is looked up. Unknown target → `Error: Unknown target: <fqt>`.
3. Dependencies are resolved recursively. Each newly reached package is loaded on demand and
   cached. Independent branches are built with `Promise.all`, so they are launched together.
   Each FQT is built at most once per invocation.
4. The target's own image is built. Docker output is captured line by line and kept as a
   bounded tail; it is only printed if the build fails or you passed `--verbose`.
5. If the target declared `EXPORT`, a throwaway container copies each mapped path to the
   package's directory on the host.

Each target reports itself as it goes, transitive dependencies included:

```
  ▶ //packages/base:ci:node-pnpm
  ✓ //packages/base:ci:node-pnpm  4.1s
  ▶ //packages/ui:ci:install
  ✓ //packages/ui:ci:install  12.7s
  ▶ //packages/ui:ci:build
  ✗ //packages/ui:ci:build  3.2s
```

Exit code is non-zero if any dependency's Docker build fails; the error propagates and no
further work is attempted.

## Output and logs

dagr keeps command results and progress separate:

- **stdout** is reserved for command output. Today that is the target graph produced by
  `dagr list`, so redirecting or piping it remains useful.
- **stderr** carries progress and failures, written for a human to read. Colour is used only
  when stderr is a terminal.

Subprocesses are never attached directly to the terminal. dagr pipes both streams and keeps the
most recent 100 lines of each. Those lines are normally invisible; they surface in two cases:

**On failure**, the captured tail is printed under the error, which is usually the Docker or
compiler output you actually wanted:

```
  ✗ //packages/ui:ci:build  3.2s
error: docker exited with code 1
  #8 3.001 src/app.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.
  #8 ERROR: process "pnpm build" did not complete successfully
  (rerun with --verbose for full output)
```

**With `--verbose`**, every line is printed as it arrives, prefixed with the operation that
produced it, so you can watch a slow build instead of guessing where it is stuck:

```
image.build packages_ui-ci-build │ #8 [4/4] RUN pnpm build
image.build packages_ui-ci-build │ #8 DONE 12.2s
```

Nested errors print their `cause` chain indented beneath the message.

## `dagr list`

Scans the whole repo and prints every target with its resolved dependencies, in topological
order (dependencies before dependents). It does not build targets. Because mount contents define
part of the graph, it does build and extract mount images during loading.

```
//packages/base:ci:node-pnpm[]
//packages/common:ci:install[//packages/base:ci:node-pnpm]
//packages/common:ci:build[//packages/common:ci:install]
//packages/common:ci:pack[//packages/common:ci:build]
//packages/ui:ci:install[//packages/common:ci:pack, //packages/base:ci:node-pnpm]
//packages/ui:ci:build[//packages/ui:ci:install]
//:ci:deploy[//packages/ui:ci:build]
```

Format is `//package:facet:target[dep, dep, ...]`. Dependencies are printed **fully expanded**,
so this is the way to confirm that a shorthand like `'install'` resolved to the package you
expected.

`dagr list` is also the cheapest validity check on a build file you just edited. If a package is
missing from the output, its `dagr.index.js` failed schema validation — see
[11 — Troubleshooting](11-troubleshooting.md#my-package-doesnt-show-up-in-dagr-list).

## Environment variables

Set by `cli.sh` and the published runtime image; you rarely touch them directly, but they explain
the behaviour.

| Variable | Set by | Meaning |
| --- | --- | --- |
| `REPO_ROOT` | runtime image (`/repo`) | Repo root **as seen inside the dagr container**. Used for loading `dagr.index.js` files and as the base for Docker build contexts. Falls back to dagr's own parent directory when unset. |
| `HOST_REPO_ROOT` | `cli.sh` | Repo root **on the host**. Used with `WORKING_DIR` to infer the current package. Falls back to `REPO_ROOT`. |
| `MOUNT_ROOT` | `cli.sh` (`/tmp/dagr-mounts`) | Temporary mount storage inside the dagr container. |
| `CLEAN_MOUNT_ROOT` | `cli.sh` (`1`) | Tells dagr to remove extracted contents before it exits. |
| `WORKING_DIR` | `dagr` launcher | The host directory you invoked `dagr` from. Its path relative to `HOST_REPO_ROOT` becomes the current package for FQT completion. Defaults to the repo root — in which case the relative path is empty and **no** package is inferred. |

Why two roots exist is explained in [09 — Docker-in-Docker](09-docker-in-docker.md).

## Overriding the wiring

`main` takes an optional third argument — a factory producing the DI module:

```ts
export async function main(
  args: string[],
  env: NodeJS.ProcessEnv,
  moduleFactory: ModuleFactory = defaultModule
): Promise<void>
```

`src/index.ts` calls it with the default. Tests and alternative front-ends can pass their own
factory to swap in a fake Docker builder, a fixture package map, or a different loader without
touching the command layer.
