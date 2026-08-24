# dagr

A monorepo task runner where **every target is a Docker image**.

There is no separate cache, no artifact store, and no lockfile of build outputs. A target
declares a base image and a list of Dockerfile-ish steps; dagr renders that to a real
Dockerfile, builds it, and tags the result. A target that depends on another receives the
dependency's **image tag** and uses it as its own `FROM` or as a `COPY --from=` source. Docker's
layer cache is the only cache, and the dependency graph is expressed as image lineage.

Build files are `dagr.index.js` — plain ES modules evaluated inside a `node:vm` sandbox, so they
can compute their contents with real JavaScript (loops, templates, shared helper modules)
without being able to touch the filesystem, the network, or the host process.

## Philosophy

### Open code, not a package

dagr is distributed as source. Copy the `dagr/` directory into your repository and commit it.
The repository owns the exact runner that interprets its build definitions, so there is no
external dagr version to keep compatible with them.

That copy is yours to read, modify, and evolve with the rest of the codebase. Updating dagr
means applying a source diff and reviewing it like any other change. The global launcher never
selects or downloads a version; it only finds and runs the copy owned by the current repository.

## Install

```sh
.dagr/install.sh
export PATH="$HOME/.local/bin:$PATH"
```

You need Docker with buildx. You do **not** need Node, pnpm, or TypeScript on the host — dagr runs
in a container built on first use. The `dagr` launcher walks up from your working directory looking
for a `.dagr/` directory, so one global install serves every repo that uses dagr.

To set `.dagr/` up in a repo that doesn't have one yet — four files, one of which pins the dagr
commit you want — see [10 — Adopting in a new monorepo](docs/10-adopting-in-a-new-monorepo.md).

## Use

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
          { RUN: 'node src/index.js > /out/greeting.txt' },
        ],
        IGNORE: ['node_modules', '.git'],
        EXPORT: { '/out': 'dist' },
      }),
    },
  },
}
```

```sh
dagr run packages/greeter#ci#build
```

That builds an image tagged `packages_greeter-ci-build` and copies the image's `/out` directory
to `packages/greeter/dist` on your host:

```
  ▶ packages/greeter#ci#build
  ✓ packages/greeter#ci#build  4.1s
```

Docker output is captured but hidden unless the build fails, in which case the tail is printed
under the error. Pass `--verbose` to watch every line as it happens. `dagr list` prints the whole
target graph in topological order without building anything.

## Documentation

The wiki lives in [`docs/`](docs/README.md) — concepts, the full `dagr.index.js` schema, the
sandbox rules, the CLI reference, internals, and a checklist for adopting dagr in a new
monorepo.

## Development

```sh
pnpm install
make typecheck
make test        # compiles to dist/, then runs the tests against it
```

## License

See [LICENSE](LICENSE).
