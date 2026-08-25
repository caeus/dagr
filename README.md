# dagr

dagr is a monorepo task runner where every target produces a Docker image.

That makes target outputs directly composable. A downstream target can inherit a dependency
with `FROM` or copy files from it with `COPY --from`, without publishing artifacts or moving
them through a separate cache. Docker's layer cache reuses unchanged work, while an optional
`EXPORT` copies the final files you actually want back into the workspace.

The result is one dependency graph, one artifact format, and one persistent build cache. Expensive
setup steps remain reusable, package builds stay isolated, and the same definitions run anywhere
Docker does.

The name compresses **DAG runner** into `dagr`.

## How it works

A target declares dependencies, a base image, and a list of Dockerfile-like steps. dagr builds its
dependencies first and passes their image tags to the target. The target may use those images as
build inputs or merely depend on them for scheduling.

Build definitions are `dagr.index.js` files. They are plain ES modules evaluated inside a
`node:vm` sandbox, so they can use JavaScript, templates, loops, and shared helper modules without
access to the filesystem, network, or host process.

There is no separate task cache, artifact store, or lockfile of build outputs. Docker images and
layers provide those mechanics.

## Pinned source, not a package

dagr is not published as a package. A consuming repository keeps four small bootstrap files under
`.dagr/`, including a Dockerfile that pins an exact dagr commit. On first use, that Dockerfile
clones and compiles the pinned source into the runner image. Docker caches the result for later
invocations.

The runner version therefore lives beside the definitions it interprets. Updating dagr is an
explicit commit change that can be reviewed like any other dependency update.

## Adopt

You need Docker with buildx and access to the Docker socket. You do **not** need Node, pnpm, or
TypeScript on the host.

First, create the repository's `.dagr/` directory and pin a dagr commit by following
[Adopting dagr in a new monorepo](docs/10-adopting-in-a-new-monorepo.md). Then install the launcher:

```sh
.dagr/install.sh
export PATH="$HOME/.local/bin:$PATH"
```

The launcher walks up from your current directory to find `.dagr/`, so one global command works
across every repository that uses dagr.

## Use

Given this tiny program:

```js
// packages/greeter/src/index.js
console.log('hello from dagr')
```

Define how to build and export it:

```js
// packages/greeter/dagr.index.js
export default {
  ci: {
    build: {
      deps: [],
      run: () => ({
        FROM: 'node:22-alpine',
        steps: [
          { WORKDIR: '/repo' },
          { COPY: { src: 'src', dest: '/repo/src' } },
          { RUN: 'mkdir -p /out && node src/index.js > /out/greeting.txt' },
        ],
        IGNORE: ['node_modules', '.git'],
        EXPORT: { '/out': 'dist' },
      }),
    },
  },
}
```

Run the target:

```sh
dagr run packages/greeter#ci#build
```

The first run builds the target. Later runs reuse every Docker layer unaffected by your changes.
Here, `EXPORT` makes the result available at `packages/greeter/dist`. Without `EXPORT`, the
image can remain an internal build input for downstream targets without writing anything to the
host.

Docker output stays hidden unless a build fails, in which case dagr prints the captured tail under
the error. Pass `--verbose` to stream every line. Use `dagr list` to inspect the complete target
graph without building targets, except for any mounts required to discover that graph.

## Documentation

The complete documentation lives in [`docs/`](docs/README.md), including concepts, the
`dagr.index.js` schema, sandbox rules, CLI reference, dependency and export semantics, mounts,
internals, troubleshooting, and the adoption checklist.

## Development

```sh
pnpm install
make typecheck
make test
```

## License

See [LICENSE](LICENSE).
