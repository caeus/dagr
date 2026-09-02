# Authoring `dagr.index.js`

A `dagr.index.js` file is an ES module whose **default export** describes either one package's
facets and targets or a mounted package tree.

## The shape

```js
export default {
  <facetName>: {
    <targetName>: {
      deps: [ /* target references, strings */ ],
      run: ({ images, host }) => ({
        FROM: '<image ref>',
        steps: [ /* Step objects */ ],
        IGNORE: [ /* .dockerignore entries */ ],
        EXPORT: { '<abs path in image>': '<path relative to package dir>' },  // optional
      }),
    },
  },
}
```

Facet and target names must match `[A-Za-z0-9][A-Za-z0-9._-]*`. The leading alphanumeric
requirement prevents names from behaving like command options, hidden paths, or dagr directives.
In particular, `/` cannot collide with a facet.

Notes on validation:

- `deps` is required. A target with no dependencies writes `deps: []` — there is no implicit
  default, so a missing `deps` is a validation failure, not an empty list.
- `run` must be a function. It is *not* called during loading — only when the target is
  actually built.
- `ctx.images` maps each dependency string exactly as declared to its built image tag.
- `ctx.host` describes the user's OS, architecture, and, on Linux, libc.
- `steps` is required. Use `steps: []` for a target that only re-tags or re-exports its base.
- `IGNORE` is required, and `IGNORE: []` means "upload the whole context". Also no default —
  see [`IGNORE`](#ignore) below.
- Unknown or misspelled fields are rejected.

## Package location

Each `dagr.index.js` can read its canonical logical package location from
`import.meta.dagr.location`:

```js
const location = import.meta.dagr.location // `//services/api`
```

The repository root and the root of every mounted source tree receive `//`. A package `//c` inside a
mounted tree receives `//c`, regardless of whether that tree was mounted at `//tools`,
`//vendor/tools`, or anywhere else. A mountee cannot observe its mounter through this API.

The value is read-only and never contains a physical checkout or temporary mount path, so the same
source tree observes the same locations on every host and under every mounter.

## `/`

A mount replaces the directory containing its `dagr.index.js` with the resulting image's final
`WORKDIR`:

```js
export default {
  '/': {
    FROM: 'ghcr.io/acme/dagr-tools:1',
    steps: [{ WORKDIR: '/dagr' }],
    IGNORE: [],
  },
}
```

It cannot contain facets, `deps`, `run`, or `EXPORT`. The mounted image must declare a final
`WORKDIR` other than `/`; that directory becomes the mounted source root. A mount has no source
build context and cannot depend on targets.

For example, a mount at `stacks/tools` whose final workdir contains `c/dagr.index.js` exposes
`//stacks/tools//c:facet:target`. The `//` is a canonical image-boundary marker, not a filesystem
path normalization accident. A `dagr.index.js` at the workdir root exposes
`//stacks/tools//:facet:target`. Nested mounts add one `//` at every boundary.

The same boundary syntax works in root-relative build-file imports. For example,
`//stacks/tools//dagr.shared.js` materializes the mount at `stacks/tools` and imports the file
from its final `WORKDIR`. Imports made by that module use the mounted tree as their `//` root.

Targets loaded inside the mounted tree remain ordinary targets, including their `deps` and
image recipes. They may be used as dependencies. If such a target declares `EXPORT` and is run
directly, dagr rejects the export because its `//` package identity cannot map unambiguously onto
a host filesystem path.

`dagr list` does not materialize mounts. A mount is loaded when an explicit target or import crosses
its boundary.

## `run(context)`

`run` is evaluated when a target is built and when its recipe is inspected with `dagr show`.
During one `dagr run`, each reached target is evaluated at most once because its in-flight build is
memoized. The `images` object maps each entry of `deps` to that dependency's built **image tag**.
The keys are the dep strings **exactly as you wrote them**. See
[Dependencies and `EXPORT`](05-deps-and-exports.md#the-images-map).

`run` must be deterministic and pure. It is evaluated inside the sandbox and has no access to the
filesystem.

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

Here `tools/dagr.index.js` must declare a mount. Dagr materializes the mounted image's final
`WORKDIR`, passes it to BuildKit as a named build context, and copies `include/a.h` from that
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
{ COPY: { from: images['//libraries/common:ci:pack'], src: '/out/pkg.tgz', dest: '/repo/pkg.tgz' } }
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
// lib/dagr.file_utils.js
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

Base64 encoding avoids shell quoting failures when content contains newlines, quotes, or `$`.

The tradeoff: any change to the file's contents invalidates that layer and everything after
it. That is correct behaviour, and it is why config writes belong early in the step list,
before the expensive install.
