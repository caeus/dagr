# Troubleshooting

Start with:

```sh
dagr list
```

This confirms which source packages and targets Dagr can currently load. It does not materialize
mounts.

## A package or target is missing

Check that:

- the file is named exactly `dagr.index.js`;
- the file has a default export;
- every target has `deps` and a `run` function;
- facet and target names match the address you used;
- imported helper files use supported `dagr.*` names;
- the package is not inside `.git` or a mount.

Reduce the file to one small target, confirm it appears, then add definitions back until the invalid
part is isolated.

## `Unknown target`

Compare the address with `dagr list`. A complete target address has package, facet, and target:

```text
//services/api:ci:build
```

Directory names and facet names are not inferred conventions. `//services/api` and `ci` are ordinary
names chosen by the repository.

Use the complete address when in doubt.

## `Facet required when only target is provided`

Include the facet:

```sh
dagr run ci:build
```

`dagr run build` is ambiguous because a package can contain the same target name in several facets.

## An import fails

Dagr imports are rooted at a source or mount boundary and start with `//`. Relative imports are not
supported:

```js
import helper from '//build/dagr.helper.js'
```

Importable files must be named `dagr.*.js`, `dagr.*.json`, `dagr.*.yaml`, or `dagr.*.toml`.

For a mounted stack, a second `//` crosses the mount boundary:

```js
import stack from '//stacks/ts//dagr.stack.js'
```

See [Build-file environment and imports](04-sandbox-and-imports.md) for the complete rules.

## A target definition is rejected

Each target needs this basic shape:

```js
build: {
  deps: [],
  run: () => ({
    FROM: 'alpine:3.22',
    steps: [],
    IGNORE: [],
  }),
}
```

Check spelling carefully, especially `FROM`, `steps`, `IGNORE`, `COPY.src`, and `COPY.dest`. Dagr
rejects unknown fields instead of guessing what they mean.

## A dependency cycle is reported

The error includes the target path that loops back on itself. Remove one dependency edge or split
the shared work into a third target that both sides can depend on.

## A `RUN` step cannot write a file

Create or select the destination directory before writing:

```js
steps: [
  { WORKDIR: '/repo' },
  { RUN: 'mkdir -p config && touch config/generated.json' },
]
```

When generating arbitrary contents, avoid embedding unescaped data directly in shell commands.

## `EXPORT` produced nothing

Check two things:

1. Run the exporting target directly. Exports from dependency targets are not copied to the host.
2. Confirm the source path exists in the target's final image.

Exported files are written relative to the package directory. See
[Dependencies and exports](05-deps-and-exports.md).

## Exported dependencies fail on the host

Dependencies installed inside a Linux image may contain Linux-specific binaries. They are not a
portable replacement for a host installation on macOS or Windows. Export generated configuration
and source artifacts where possible; install host tooling on the host.

## Everything rebuilds

Read the build output and find the first step that is not cached. Common causes are:

- copying frequently changed source before installing dependencies;
- generated files containing timestamps or random values;
- an upstream target producing a changed image.

Put stable dependency setup before volatile source copies.

## Docker is unavailable

Dagr needs a reachable Docker daemon with Buildx support. Confirm these work outside Dagr:

```sh
docker version
docker buildx version
```

If either fails, fix the Docker installation or daemon connection first.
