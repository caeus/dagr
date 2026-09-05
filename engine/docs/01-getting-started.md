# Getting started

## Prerequisites

- Docker with Buildx
- access to a Docker daemon through `/var/run/docker.sock`
- a POSIX-compatible shell

Dagr runs from a pinned container image. The launcher mounts the Docker socket into that image.
Access to the Docker socket is effectively root access to the host, so run only trusted Dagr
images and repository definitions.

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

This recursively scans the repository, skipping `.dagr` and `.git`. It does not materialize mounts.

## Run a target

```sh
dagr run //services/api:ci:build
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
