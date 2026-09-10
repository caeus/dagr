# Build-file environment and imports

`dagr.index.js` and imported `dagr.*.js` files use standard ES module syntax in a restricted
JavaScript environment.

## Available APIs

Build files can use standard JavaScript values and `Buffer`. Dagr also provides:

```js
import YAML from 'dagr:yaml'
import TOML from 'dagr:toml'
import Glob from 'dagr:glob'
```

YAML and TOML expose `stringify` through their default export and as a named export. Glob exposes
`of` the same way. `Glob.of(pattern)` validates and compiles the pattern once, returning a reusable
predicate:

```js
const isFile = Glob.of('file/*')
isFile('file/tsconfig')   // true
isFile('file/foo/bar')    // false

const isTarget = Glob.of('target/**')
isTarget('target')          // true
isTarget('target/ci/build') // true
```

Glob matching is synchronous string matching only; it never reads the filesystem. `/` separates
segments, `*` matches exactly one non-empty segment, and `**` matches zero or more non-empty
segments. Wildcards must occupy an entire segment. Empty patterns, empty pattern segments, and
partial wildcard segments such as `foo*` or `***` are rejected by `Glob.of(...)` rather than
assigned extra glob semantics.

Build files cannot access the host environment, filesystem, network, processes, timers, CommonJS
globals, or arbitrary Node modules. In particular, `process`, `require`, `fetch`, and `fs` are not
available. Put configuration in importable Dagr files or literals instead.

Build definitions should be deterministic. Avoid timestamps, randomness, and mutable module state.

## File imports

File imports begin with `//` and are rooted at the source tree containing the importing module:

```js
import versions from '//build/dagr.versions.yaml'
import { writeJson } from '//build/dagr.files.js'
```

The imported filename must match one of these forms:

- `dagr.*.js`
- `dagr.*.json`
- `dagr.*.yaml`
- `dagr.*.toml`

JavaScript files support named and default exports. Data files provide a default export containing
the parsed value. Relative paths, URLs, filesystem escapes, and extension inference are not
supported.

## Mount boundaries

A second `//` crosses a mount requested by `dagr.mount.yaml`:

```js
import toolchain from '//recipes/toolchain//dagr.recipe.js'
```

Imports made inside that mounted tree resolve their own leading `//` from the mounted root. Nested
mounts add another boundary marker.

Mounts are materialized only when an explicit target or import crosses their boundary. `dagr list`
does not materialize them.

See [Filesystem composition](03-filesystem-composition.md) for how the root identifies and
implements the requested volume.

## Shared helpers

Shared build logic is ordinary Dagr JavaScript:

```js
// build/dagr.node.js
export function component({ image = 'alpine:3.22' } = {}) {
  return {
    ci: {
      build: {
        deps: [],
        run: () => ({ FROM: image, steps: [], IGNORE: ['out'] }),
      },
    },
  }
}
```

```js
// services/api/dagr.index.js
import { component } from '//build/dagr.component.js'

export default component()
```

The directory name `build` is only a repository convention.
