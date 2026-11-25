# Dependencies and `EXPORT`

## References

An exact reference is either an absolute semantic path in the current project or a fully
qualified project address and semantic path, separated by a colon.

| Reference | Meaning |
| --- | --- |
| `/app/build` | Node in the current project |
| `//packages/core:/lib/pack` | Node in another project |
| `//:/config` | Node in the root project |
| `//tools//pkg:/pack` | Node across a mount boundary |

## Named and plural dependencies

```js
deps: {
  manifest: '/app/file/build/package.json',
  files: ['/app/file/build/package-manager/**', '/app/file/build/tsconfig.json'],
  library: '//packages/core:/lib/pack',
}
```

Exact string references yield the unwrapped dependency value. A wildcard string or an
array yields a record. Local entries are keyed by semantic path; external entries by
fully qualified node address. `*` matches one segment, `**` zero or more. Matches are
deduplicated. A wildcard may match nothing; an exact reference must exist.
All selections resolve against the final graph.

A build with `path` yields `{ image, path }`. Use those fields in a subsequent
`COPY`. A build without `path` yields an image tag, usable as `FROM`.

## Cycles

The engine rejects dependency cycles, including cycles between concurrently requested
roots. Shared dependencies are evaluated once per invocation.

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

When you run `dagr run //services/api:/build`, Dagr builds every transitive dependency, but
it only materializes the `EXPORT` map of `//services/api:/build` itself. If
`//services/api:/install` also declares an `EXPORT`, nothing is written for it.

So `EXPORT` on an intermediate target is not a side effect that fires whenever the target gets
built. To receive an intermediate target's declared files, run it directly:

```sh
dagr run //services/api:/install
```

Without this rule, building anything would spray files across your working tree.
