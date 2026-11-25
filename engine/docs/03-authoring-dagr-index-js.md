# Authoring `dagr.index.js`

The default export of a project index is a plain record keyed by absolute semantic node paths.

```js
export default {
  '/app/config': {
    deps: {},
    run: () => ({ value: { name: 'app' } }),
  },
  '/app/file/package.json': {
    deps: { config: '/app/config' },
    run: ({ config }) => ({
      build: {
        FROM: 'alpine:3.22',
        steps: [
          { WORKDIR: '/repo' },
          { RUN: `echo "${Buffer.from(JSON.stringify(config)).toString('base64')}" | base64 -d > /repo/package.json` },
        ],
        IGNORE: [],
        path: '/repo/package.json',
      },
    }),
  },
  '/app/build': {
    deps: { manifest: '/app/file/package.json' },
    run: ({ manifest }) => ({
      build: {
        FROM: 'node:22-alpine',
        steps: [
          { COPY: { from: manifest.image, src: manifest.path, dest: '/repo/package.json' } },
        ],
        IGNORE: [],
      },
    }),
  },
}
```

## Node shape

`deps` is a record of local names to semantic references or plural selections.
`run(args, host)` receives resolved values under exactly those local names. The optional
second parameter exposes the host platform (`os`, `arch`, and Linux `libc`).

Return exactly one of `{ value: anything }` and `{ build: recipe }`. A build recipe
contains `FROM`, `steps`, `IGNORE`, optional `path` and optional `EXPORT`.
Without `path`, its dependency value is an image tag. With an absolute normalized image
path, its value is `{ image, path }`. A path may denote a directory.

## Project location and mounts

`import.meta.dagr.location` names the project's logical filesystem address within its
source root. It is not a node prefix. Mounts are declared separately in `dagr.mount.yaml`.
See [Filesystem composition](03-filesystem-composition.md).

## Step reference

Each step is a single-key object:

| Step | Renders to |
| --- | --- |
| `{ RUN: 'cmd' }` | `RUN cmd` |
| `{ WORKDIR: '/repo' }` | `WORKDIR /repo` |
| `{ ENV: { A: '1', B: '2' } }` | `ENV A=1` and `ENV B=2` (one line per key) |
| `{ COPY: { src, dest } }` | `COPY src dest` |
| `{ COPY: { from, src, dest } }` | `COPY --from=from src dest` |
| `{ ENTRYPOINT: ['node', 'x.js'] }` | `ENTRYPOINT ["node","x.js"]` (JSON form) |
| `{ CMD: ['sh'] }` | `CMD ["sh"]` (JSON form) |

`FROM` is not a step — it is the `FROM` field of the returned object, and it is always
emitted first.

`ENTRYPOINT` and `CMD` always render in exec (JSON) form, so they take an array of strings,
never a shell string.

### `COPY` and the build context

`src` in an ordinary `COPY` without `from` is resolved against the **build context**, which is
the package's own directory. For `services/api`, `{ COPY: { src: 'src', dest: '/repo/src' } }`
copies `services/api/src`. An ordinary source cannot escape that directory.

A source containing `//` deliberately crosses a mount boundary relative to the package:

```js
{ COPY: { src: 'tools//include/a.h', dest: '/include/a.h' } }
```

Here `tools/dagr.mount.yaml` must request a volume. Dagr materializes the volume's final `WORKDIR`,
passes it to BuildKit as a named build context, and copies `include/a.h` from that
context. Several copies from the same mount reuse one materialized context. Every path segment
before a `//` must resolve to a mount.

When `from` is present, `src` is interpreted inside that explicitly named image and `//` has no
special meaning:

```js
{ COPY: { from: images.tools, src: '/include/a.h', dest: '/include/a.h' } }
```

What the package context excludes is controlled by `IGNORE`, described next.

## `IGNORE`

`IGNORE` controls the target's Docker build context as a list of ignore patterns. Dagr adds no
patterns of its own.

```js
IGNORE: ['.git', 'out']
```

It is **required**, deliberately. Nothing is excluded unless a target says so, which means the
cost of a large build context is always visible in the target that pays it rather than hidden
in dagr. `IGNORE: []` is legal and means "upload everything in the context".

Because it is required and has no default, the sensible pattern is to keep the list in one
place and import it, rather than repeating literals:

```js
// lib/dagr.dockerignore.js
export const RECOMMENDED_IGNORE = ['.git', 'out']
```

```js
import { RECOMMENDED_IGNORE } from '//lib/dagr.dockerignore.js'

run: () => ({ FROM: '…', steps: [ … ], IGNORE: RECOMMENDED_IGNORE })
```

With `from`, `src` is an absolute path inside the referenced image and the context is not
involved:

```js
{ COPY: { from: images['//libraries/common:/pack'], src: '/out/pkg.tgz', dest: '/repo/pkg.tgz' } }
```

## Ordering gotcha: `WORKDIR` creates directories

Steps that write files need their target directory to exist. Docker's `WORKDIR` creates it;
a bare `RUN ... > /repo/file` does not. So put `WORKDIR` before any file-writing step:

```js
steps: [
  { WORKDIR: '/repo' },              // creates /repo
  writeText('/repo/config', config),
  { RUN: './install-dependencies' },
]
```

## Generating file contents

A common need is writing a config file whose contents are computed in JavaScript. Because a
step is just a `RUN`, a helper can return one:

```js
// lib/dagr.file-utils.js
export function writeText(path, content) {
  return { RUN: `echo "${Buffer.from(content).toString('base64')}" | base64 -d > ${path}` }
}

export function writeJson(path, value) {
  return writeText(path, JSON.stringify(value, null, 2))
}
```

YAML and TOML encoding are Dagr built-ins, so repositories do not need hand-written serializers
or access to arbitrary packages:

```js
import YAML from 'dagr:yaml'
import TOML from 'dagr:toml'

export function writeYaml(path, value) {
  return writeText(path, YAML.stringify(value))
}

export function writeToml(path, value) {
  return writeText(path, TOML.stringify(value))
}
```

Dagr also provides a small segment glob matcher for semantic path-like identifiers:

```js
import Glob from 'dagr:glob'

const isVitestCommand = Glob.of('command/*/vitest')
isVitestCommand('command/test/vitest') // true

const isTarget = Glob.of('target/**')
isTarget('target')                     // true
```

`Glob.of(pattern)` validates and compiles the pattern once and returns a reusable predicate.
`*` matches one segment and `**` matches zero or more segments. Wildcards are whole segments only;
this utility does not implement filesystem globbing or read the filesystem.

Base64 encoding avoids shell quoting failures when content contains newlines, quotes, or `$`.

The tradeoff: any change to the file's contents invalidates that layer and everything after
it. That is correct behaviour, and it is why config writes belong early in the step list,
before the expensive install.
