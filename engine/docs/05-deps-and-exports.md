# Dependencies and `EXPORT`

## Reference shorthands

A target reference is a `:`-separated string with one, two, or three segments. Missing
segments are filled from the target's context:

| Written | Segments | Resolves to |
| --- | --- | --- |
| `//services/api:ci:build` | 3 | Exactly that. Always unambiguous. |
| `ci:build` | 2 | `<current package>:ci:build` |
| `build` | 1 | `<current package>:<current facet>:build` |

Inside a `deps` array, "context" is the package **and** facet of the target doing the
depending. So all three forms work in `deps`:

```js
export default {
  ci: {
    install: { deps: [], run: ... },
    build:   { deps: ['install'], run: ... },                      // same package, same facet
    docs:    { deps: ['release:bundle'], run: ... },               // same package, other facet
    deploy:  { deps: ['//services/api:ci:build'], run: ... },       // another package
  },
}
```

On the command line, `facet:target` may be used from that package's directory. A bare target name
is not accepted:

```sh
cd services/api
dagr run ci:build
```

Elsewhere, use the full address. A root-package target uses `//:facet:target`:

```sh
cd <repo root>
dagr run //:ci:deploy
```

## The `images` map

`run` receives `ctx.images`, keyed by the dep strings **exactly as written in `deps`** — not
by their expanded FQTs. This trips people up constantly:

```js
{
  deps: ['install', '//libraries/common:ci:pack'],
  run: ({ images }) => ({
    FROM: images['install'],                          // ✓ the literal string from deps
    steps: [{ COPY: { from: images['//libraries/common:ci:pack'], src: '/out/x.tgz', dest: '/x.tgz' } }],
  })
}
```

```js
images['//services/api:ci:install'] // undefined: the dependency was declared as 'install'
```

The values are Dagr-generated image tags. A dep you declare but never read is still built;
declaring it is what schedules it.

Two practical habits follow. If you build dep strings programmatically, keep the same
expression for both the `deps` entry and the lookup:

```js
const BASE = '//foundation:ci:toolchain'

return {
  install: {
    deps: [BASE],
    run: ({ images }) => ({ FROM: images[BASE], steps: [...] }),
  },
}
```

And if you generate a list of deps, generate the lookups the same way:

```js
const packTargets = localDeps.map(d => `//libraries/${d.local}:ci:pack`)
// ...
deps: [...packTargets, BASE],
run: ({ images }) => ({
  FROM: images[BASE],
  steps: localDeps.map(d => ({
    COPY: { from: images[`//libraries/${d.local}:ci:pack`], src: `/out/${d.local}.tgz`, dest: `/repo/${d.local}.tgz` },
  })),
}),
```

## Cycles

Cycles are detected while walking the graph and reported with the full path:

```
Circular dependency: //pkg:ci:a -> //pkg:ci:b -> //pkg:ci:a
```

The check happens at run time, not load time, so `dagr list` will happily print a cyclic graph
(with a truncated topological order). `dagr run` is what catches it.

## `EXPORT`

`EXPORT` is how files get out of an image and onto your host filesystem. It is a
map, and the direction of each half is the thing to remember:

> **Keys are absolute paths inside the image. Values are paths relative to the package's
> directory on the host.**

```js
// in services/api/dagr.index.js
EXPORT: {
  '/repo/dist': 'dist',              // image /repo/dist → services/api/dist
}
```

```js
// in a dagr.index.js at the repository root
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
  generated config to my host" target practical: generate files inside the image and export
  exactly the ones the host should receive.
- **The no-slash form deletes first.** Replacing removes the destination before copying, so
  files the build no longer produces disappear. This is what stops a hash-named bundle directory
  from accumulating every past build. Use the slash form when you want additive behaviour.

### The package directory cannot be replaced

`'.'` is rejected, because it is the replace form aimed at the package directory itself:

```
EXPORT "/docs" -> ".": cannot replace the package directory itself; use "./" to merge into it
```

The destination is that local package directory; for the root package, it is your entire
repository. A replace there would `rm -rf` the working tree. The merge form `'./'` is fine
and often what you want: it copies into the package directory without deleting anything, which
is how you'd sync a whole directory of generated files without listing each one.

```js
EXPORT: { '/out/': './' }    // contents of /out merged into the package directory
EXPORT: { '/repo/dist': './' } // replaces just <pkg>/dist — safe, the root is untouched
```

### Only the invoked target exports

This is the most important rule about `EXPORT` and it is deliberate.

When you run `dagr run //services/api:ci:build`, Dagr builds every transitive dependency, but
it only materializes the `EXPORT` map of `//services/api:ci:build` itself. If
`//services/api:ci:install` also declares an `EXPORT`, nothing is written for it.

So `EXPORT` on an intermediate target is not a side effect that fires whenever the target gets
built. To receive an intermediate target's declared files, run it directly:

```sh
dagr run //services/api:ci:install
```

Without this rule, building anything would spray files across your working tree.
