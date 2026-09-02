# Getting started

## Prerequisites

- Docker with Buildx
- access to a Docker daemon

Node, pnpm, and TypeScript are not required on the host. Dagr runs from a pinned container image.

## Install the launcher

From a repository that contains `.dagr/`:

```sh
.dagr/install.sh
export PATH="$HOME/.local/bin:$PATH"
```

The repository controls its Dagr version through the image pin in `.dagr/cli.sh`.

## Find targets

```sh
dagr list
```

This recursively scans source directories, skipping `.git` and `node_modules`. It does not
materialize mounts.

## Run a target

```sh
dagr run //apps/web:ci:build
```

A target address contains its package path, facet, and target name. Dagr builds its transitive
dependencies first and reuses shared dependencies within the invocation.

## Run Dagr's checks

In this repository:

```sh
dagr run //engine:ci:typecheck //engine:ci:test
```

Continue with [Concepts](02-concepts.md) for the build model or
[Authoring `dagr.index.js`](03-authoring-dagr-index-js.md) to define a package.
