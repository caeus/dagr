# Getting started

## Prerequisites

- **Docker** with **buildx**. dagr shells out to `docker buildx build --load`, so a plain
  legacy `docker build` is not enough.
- Access to the Docker socket at `/var/run/docker.sock`. dagr itself runs in a container
  and drives your host daemon through that socket.

You do **not** need Node, pnpm, or TypeScript on the host. dagr ships as a Docker image
that it builds from its own `Dockerfile` on first use.

## Install the launcher

```sh
dagr/install.sh
```

That symlinks `dagr/dagr` into `~/.local/bin/dagr`. Make sure that directory is on your
`PATH`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## What the launcher does

`dagr` is a three-line shell script with one job: find the monorepo. It records your current
directory, then walks up the tree looking for a directory named `dagr`. When it finds
one it execs `dagr/cli.sh`, passing your original directory through as `WORKING_DIR`.

That means a single global `dagr` works across every monorepo that vendors dagr — the
launcher resolves to whichever copy is above your cwd. If no ancestor contains a `dagr/`
directory, it fails with:

```
error: not inside a monorepo (no dagr/ directory found in any parent)
```

`cli.sh` then builds the dagr image and runs it:

```sh
docker build -t dagr "$REPO_ROOT/dagr"
docker run --rm \
  -v "$REPO_ROOT:/repo" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e HOST_REPO_ROOT="$REPO_ROOT" \
  -e WORKING_DIR="${WORKING_DIR:-$REPO_ROOT}" \
  dagr "$@"
```

The `docker build` runs on every invocation. After the first time it is fully layer-cached,
so it costs well under a second — but it does mean edits to `dagr/src/` take effect on
the next `dagr` call with no separate build step.

## First run

From anywhere inside the monorepo:

```sh
dagr list
```

This loads every `dagr.index.js` in the repo and prints the whole target graph in topological
order. It builds nothing, so it is the safe way to confirm your setup and to check that a
build file you just wrote actually parsed.

Then build something:

```sh
dagr run packages/ui#ci#build
```

## Running from inside a package

`WORKING_DIR` lets dagr infer the package you are standing in, so you can drop the package
segment of the target name:

```sh
cd packages/ui
dagr run ci#build      # same as: dagr run packages/ui#ci#build
```

The facet is never inferred — `dagr run build` fails. See
[05 — Dependencies and `EXPORT`](05-deps-and-exports.md#reference-shorthands) for the full
resolution rules.

## Running dagr's own checks

dagr is a normal pnpm package, so its own tests and typecheck run outside Docker:

```sh
cd dagr
pnpm install
pnpm typecheck
pnpm test
```
