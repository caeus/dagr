# Getting started

## Prerequisites

- **Docker** with **buildx**. dagr shells out to `docker buildx build --load`, so a plain
  legacy `docker build` is not enough.
- Access to the Docker socket at `/var/run/docker.sock`. dagr itself runs in a container
  and drives your host daemon through that socket.

You do **not** need Node, pnpm, or TypeScript on the host. dagr runs from a published,
commit-pinned Docker image.

## Install the launcher

```sh
.dagr/install.sh
```

That symlinks `.dagr/dagr` into `~/.local/bin/dagr`. Make sure that directory is on your
`PATH`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## What the launcher does

`dagr` is a three-line shell script with one job: find the monorepo. It records your current
directory, then walks up the tree looking for a directory named `.dagr`. When it finds
one it execs `.dagr/cli.sh`, passing your original directory through as `WORKING_DIR`.

That means a single global `dagr` works across every monorepo that vendors dagr — the
launcher resolves to whichever copy is above your cwd. If no ancestor contains a `.dagr/`
directory, it fails with:

```
error: not inside a monorepo (no .dagr/ directory found in any parent)
```

`cli.sh` then runs the pinned dagr image:

```sh
docker run --rm --pull=missing \
  -v "$REPO_ROOT:/repo" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e HOST_REPO_ROOT="$REPO_ROOT" \
  -e WORKING_DIR="${WORKING_DIR:-$REPO_ROOT}" \
  "ghcr.io/caeus/dagr:<commit-sha>" "$@"
```

Docker downloads the image once and reuses it locally. Upgrading Dagr is an explicit change to the
image SHA in `.dagr/cli.sh`.

## First run

From anywhere inside the monorepo:

```sh
dagr list
```

This scans the root package and `packages/`, then prints the discovered target graph in
topological order. It does not build targets, though it materializes any mounts needed for
discovery. Use it to confirm your setup and check that a build file actually parsed.

Then build something:

```sh
dagr run //packages/ui:ci:build
```

## Running from inside a package

`WORKING_DIR` lets dagr infer the package you are standing in, so you can drop the package
segment of the target name:

```sh
cd packages/ui
dagr run ci:build      # same as: dagr run //packages/ui:ci:build
```

The facet is never inferred — `dagr run build` fails. See
[05 — Dependencies and `EXPORT`](05-deps-and-exports.md#reference-shorthands) for the full
resolution rules.

## Running dagr's own checks

These run in a checkout of the Dagr repository itself through its pinned bootstrap image:

```sh
dagr run //engine:ci:typecheck //engine:ci:test
```
