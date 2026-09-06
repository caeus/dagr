# Authoring and debugging Dagr

Use this reference when working in a repository that uses Dagr.

## Addresses

A fully-qualified target is `//package:facet:target`, for example `//services/api:ci:build`.

Inside `deps`, shorter forms inherit context:

- `build` means the same package and facet.
- `release:bundle` means the same package, another facet.
- `./api:ci:build` is relative to the current package.
- `//services/api:ci:build` is anchored at the repository root.

On the CLI, prefer a complete address when there is any ambiguity. A bare target name is not accepted because a package can contain the same target name in multiple facets.

## Target shape

```js
export default {
  ci: {
    build: {
      deps: [],
      run: ({ images, host }) => ({
        FROM: 'alpine:3.22',
        steps: [],
        IGNORE: [],
      }),
    },
  },
}
```

`deps`, `run`, `steps`, and `IGNORE` are all explicit and required.

`ctx.images` uses the literal dependency strings from `deps` as keys:

```js
const BASE = '//foundation:ci:toolchain'

{
  deps: [BASE],
  run: ({ images }) => ({
    FROM: images[BASE],
    steps: [],
    IGNORE: [],
  }),
}
```

Do not resolve the address yourself and then use the resolved address as the key unless that exact string is what appears in `deps`.

## Recipe steps

Supported recipe concepts mirror a small Dockerfile vocabulary: `FROM`, `RUN`, `WORKDIR`, `ENV`, `COPY`, `ENTRYPOINT`, and `CMD`.

`FROM` is a recipe field, not a step. `ENTRYPOINT` and `CMD` use arrays of strings.

`WORKDIR` creates its directory. Put it before steps that write into that directory.

For caching, keep stable expensive work before volatile source copies when practical.

## COPY

Without `from`, `COPY.src` is relative to the package directory used as the build context:

```js
{ COPY: { src: 'src', dest: '/repo/src' } }
```

It cannot escape the package context.

A `//` in an ordinary source path crosses a declared mount boundary:

```js
{ COPY: { src: 'tools//include/a.h', dest: '/include/a.h' } }
```

With `from`, `src` is a path inside the named dependency image and `//` has no mount meaning:

```js
{ COPY: { from: images.tools, src: '/out/tool', dest: '/tool' } }
```

## Imports and determinism

Dagr build files are ES modules in a restricted environment. Standard JavaScript values and `Buffer` are available. Dagr provides YAML and TOML stringifiers through `dagr:yaml` and `dagr:toml`.

Do not use host-dependent APIs such as `process`, `require`, `fetch`, `fs`, timers, arbitrary Node modules, network reads, environment reads, or filesystem reads.

Repository imports start with `//` and imported files must use Dagr importable names such as `dagr.*.js`, `dagr.*.json`, `dagr.*.yaml`, or `dagr.*.toml`. Relative imports are not supported.

## EXPORT

`EXPORT` maps absolute paths inside the final target image to paths relative to the package directory on the host:

```js
EXPORT: {
  '/repo/dist': 'dist',
}
```

A trailing slash means contents/merge semantics; no trailing slash means the exact node/replacement semantics.

Only the target explicitly requested by `dagr run` materializes its `EXPORT`. An intermediate dependency's export is not written merely because the dependency was built.

## Mounts

`dagr.mount.yaml` requests a volume. Root `.dagr/config.js` identifies that request, and root `.dagr/volumes.yaml` selects its implementation. The root repository owns volume identity and implementation policy.

Mounts are lazy. `dagr list` leaves them opaque; a target, import, or mounted `COPY` crossing the boundary causes materialization.

A second `//` in a package path marks crossing a mount boundary, for example `//stacks/tools//c:ci:pack`.

## Debugging workflow

Start with:

```sh
dagr list
dagr show <address>
```

Then run the smallest relevant target:

```sh
dagr run <address>
```

If a package is missing, check the exact `dagr.index.js` filename, default export, target shapes, names, and importable helper filenames.

If a target is unknown, compare the address directly with `dagr list` rather than assuming package or facet conventions.

If everything rebuilds, find the first uncached Docker layer and inspect recipe ordering and volatile inputs.

Canonical references:

- https://caeus.github.io/dagr/02-concepts/
- https://caeus.github.io/dagr/03-authoring-dagr-index-js/
- https://caeus.github.io/dagr/03-filesystem-composition/
- https://caeus.github.io/dagr/04-sandbox-and-imports/
- https://caeus.github.io/dagr/05-deps-and-exports/
- https://caeus.github.io/dagr/06-cli/
- https://caeus.github.io/dagr/11-troubleshooting/
