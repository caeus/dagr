# Build-file environment and imports

`dagr.index.js` and imported `dagr.*.js` files use standard ES module syntax in a restricted
JavaScript environment.

## Available APIs

Build files can use standard JavaScript values and `Buffer`. Dagr also provides:

```js
import YAML from 'dagr:yaml'
import TOML from 'dagr:toml'
```

Both modules expose `stringify` through their default export and as a named export.

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

A second `//` crosses a mount declared by `dagr.index.js`:

```js
import toolchain from '//stacks/toolchain//dagr.stack.js'
```

Imports made inside that mounted tree resolve their own leading `//` from the mounted root. Nested
mounts add another boundary marker.

Mounts are materialized only when an explicit target or import crosses their boundary. `dagr list`
does not materialize them.

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
