# Dependencies and `EXPORT`

## Reference shorthands

A target reference is a `#`-separated string with one, two, or three segments. Missing
segments are filled from context (`FQT.parse` in `src/runner/index.ts`):

| Written | Segments | Resolves to |
| --- | --- | --- |
| `packages/ui#ci#build` | 3 | Exactly that. Always unambiguous. |
| `ci#build` | 2 | `<current package>#ci#build` |
| `build` | 1 | `<current package>#<current facet>#build` |

Inside a `deps` array, "context" is the package **and** facet of the target doing the
depending. So all three forms work in `deps`:

```js
export default {
  ci: {
    install: { deps: [], run: ... },
    build:   { deps: ['install'], run: ... },                      // same package, same facet
    docs:    { deps: ['release#bundle'], run: ... },               // same package, other facet
    deploy:  { deps: ['packages/ui#ci#build'], run: ... },         // another package
  },
}
```

On the **command line**, only the package is inferred, from `WORKING_DIR`. There is no current
facet, so a bare target name always fails:

```sh
cd packages/ui
dagr run packages/ui#ci#build   # ✓
dagr run ci#build               # ✓ package inferred from cwd
dagr run build                  # ✗ Error: Facet required when only target is provided: build
```

**At the repo root, nothing is inferred.** `currentPackage` is computed as
`relative(hostRoot, WORKING_DIR)`, which is the empty string when the two are the same, and an
empty package means no context is passed at all. So from the repo root every FQT must be fully
qualified — including targets of the root package itself, whose package name is `.`:

```sh
cd <repo root>
dagr run .#ci#deploy            # ✓
dagr run ci#deploy              # ✗ Error: Package required when only facet#target is provided
```

## The `images` map

`run` receives `ctx.images`, keyed by the dep strings **exactly as written in `deps`** — not
by their expanded FQTs. This trips people up constantly:

```js
{
  deps: ['install', 'packages/common#ci#pack'],
  run: ({ images }) => ({
    FROM: images['install'],                          // ✓ the literal string from deps
    steps: [{ COPY: { from: images['packages/common#ci#pack'], src: '/out/x.tgz', dest: '/x.tgz' } }],
  })
}
```

```js
images['packages/ui#ci#install'] // ✗ undefined, even though that's what 'install' resolved to
```

The values are image tags (see [08 — Internals](08-internals.md#image-tag-derivation) for how
tags are derived). A dep you declare but never read is still built — declaring it is what
schedules it.

Two practical habits follow. If you build dep strings programmatically, keep the same
expression for both the `deps` entry and the lookup:

```js
const BASE = 'packages/base#ci#node-pnpm'

return {
  install: {
    deps: [BASE],
    run: ({ images }) => ({ FROM: images[BASE], steps: [...] }),
  },
}
```

And if you generate a list of deps, generate the lookups the same way:

```js
const packTargets = localDeps.map(d => `packages/${d.local}#ci#pack`)
// ...
deps: [...packTargets, BASE],
run: ({ images }) => ({
  FROM: images[BASE],
  steps: localDeps.map(d => ({
    COPY: { from: images[`packages/${d.local}#ci#pack`], src: `/out/${d.local}.tgz`, dest: `/repo/${d.local}.tgz` },
  })),
}),
```

## Cycles

Cycles are detected while walking the graph and reported with the full path:

```
Circular dependency: pkg#ci#a -> pkg#ci#b -> pkg#ci#a
```

The check happens at run time, not load time, so `dagr list` will happily print a cyclic graph
(with a truncated topological order). `dagr run` is what catches it.

## `EXPORT`

`EXPORT` is how files get out of an image and onto your host filesystem. It is a
`Record<string, string>`, and the direction of each half is the thing to remember:

> **Keys are absolute paths inside the image. Values are paths relative to the package's
> directory on the host.**

```js
// in packages/ui/dagr.index.js
EXPORT: {
  '/repo/dist': 'dist',              // image /repo/dist       → packages/ui/dist
  '/repo/node_modules': 'node_modules', // image /repo/node_modules → packages/ui/node_modules
}
```

```js
// in the root dagr.index.js (package '.')
EXPORT: { '/docs': 'docs' }          // image /docs → <repo root>/docs
```

### Trailing slashes decide what happens

Keys and values follow the convention `cp` and `rsync` use, and it is the *only* thing that
determines behaviour — dagr never inspects the image to guess whether a path is a file or a
directory:

> **A trailing slash on the source means "the contents of". A trailing slash on the destination
> means "inside this directory". No slash means "this exact node".**

| Entry | Result |
| --- | --- |
| `'/repo/dist': 'dist'` | `dist` becomes exactly `/repo/dist` — **replaced** |
| `'/repo/dist/': 'dist/'` | contents of `/repo/dist` **merged** into `dist` |
| `'/repo/dist': 'build/'` | placed inside → `build/dist`, replaced |
| `'/repo/package.json': 'package.json'` | the file becomes exactly that path, replaced |

Two consequences worth internalising:

- **Files and directories are not special cases.** `cp -a` copies either one to an exact
  destination, so a single-file export needs no different syntax. That is what makes a "sync the
  generated config to my host" target practical: generate manifests inside the image, export
  exactly the ones the host should see, and leave container-only files like `.pnpmfile.cjs`
  behind.
- **The no-slash form deletes first.** Replacing removes the destination before copying, so
  files the build no longer produces disappear. This is what stops a hash-named bundle directory
  from accumulating every past build. Use the slash form when you want additive behaviour.

Since a replace deletes, `EXPORT`-ing `node_modules` will remove whatever the host had there —
including a platform-correct install you did by hand. Good reason not to export `node_modules`
from a target you run casually.

### The package directory cannot be replaced

`'.'` is rejected, because it is the replace form aimed at the package directory itself:

```
EXPORT "/docs" -> ".": cannot replace the package directory itself; use "./" to merge into it
```

The destination is a bind mount of that directory — for the root package, your entire
repository — so a replace there would `rm -rf` the working tree. The merge form `'./'` is fine
and often what you want: it copies into the package directory without deleting anything, which
is how you'd sync a whole directory of generated files without listing each one.

```js
EXPORT: { '/out/': './' }    // contents of /out merged into the package directory
EXPORT: { '/repo/dist': './' } // replaces just <pkg>/dist — safe, the root is untouched
```

### Only the invoked target exports

This is the most important rule about `EXPORT` and it is deliberate.

When you run `dagr run packages/ui#ci#build`, dagr builds every transitive dependency, but
it only materializes the `EXPORT` map of `packages/ui#ci#build` itself. If
`packages/ui#ci#install` also declares an `EXPORT`, nothing is written for it.

So `EXPORT` on an intermediate target is not a side effect that fires whenever the target gets
built — it is a declaration of "here is what this target is worth extracting, *if* you ask for
it directly". To get `install`'s `node_modules` onto your host, run it directly:

```sh
dagr run packages/ui#ci#install
```

Without this rule, building anything would spray files across your working tree.

### How extraction works, and what it requires

For each `src → dest` pair, dagr runs a throwaway container with the package directory
bind-mounted. Which command runs depends only on the trailing slashes, never on inspecting the
image:

```sh
# source ends in "/" — merge contents, delete nothing
docker run --rm -v <package dir>:/host-out <image> sh -c \
  'mkdir -p "<dest>" && cp -a "<src>"/. "<dest>"/'

# otherwise — the node becomes <dest> exactly, replacing whatever was there
docker run --rm -v <package dir>:/host-out <image> sh -c \
  'mkdir -p "$(dirname "<dest>")" && rm -rf "<dest>" && cp -a "<src>" "<dest>"'
```

Implications:

- **The image needs a shell**, plus `mkdir`, `cp`, and `dirname`. You cannot `EXPORT` from a
  `scratch` or distroless image. Keep a `FROM alpine`-family layer as the export target.
- Intermediate directories in `dest` are created as needed, in both forms.
- Files are written by the container's user, typically root. Exported trees may be
  root-owned on Linux hosts.
- One container per entry, run sequentially.

### Exported `node_modules` are Linux binaries

`EXPORT`-ing `node_modules` gives you the tree that was installed inside a Linux container.
Any dependency with native or platform-gated binaries (esbuild, rollup, swc, sharp) will have
resolved to Linux artifacts. On a macOS or Windows host, tools run against that tree fail with
missing optional-dependency errors.

Exporting `node_modules` is useful for editor IntelliSense and for feeding a subsequent
container step. It is not a substitute for a local install when you want to run a dev server
on the host.
