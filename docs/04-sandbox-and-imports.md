# The sandbox and root-relative imports

`dagr.index.js` and imported `dagr.*.js` files are evaluated with `vm.SourceTextModule` in a
single fresh V8 context created once per load session. JSON, YAML, and TOML imports are parsed
and exposed as synthetic modules in the same context. This is why the dagr image's entrypoint
passes `--experimental-vm-modules` to Node.

## What is available

The context is created as:

```ts
vm.createContext(Object.assign(Object.create(null), { Buffer }))
```

**Available:**

- All ECMAScript intrinsics — `Object`, `Array`, `JSON`, `Math`, `String`, `Map`, `Set`,
  `Promise`, `Date`, template literals, spread, destructuring, classes, everything the
  language gives you. A fresh V8 context has its own copy of the standard library.
- `Buffer`, explicitly injected. It exists so build files can base64-encode generated file
  contents (see
  [03 — Authoring `dagr.index.js`](03-authoring-dagr-index-js.md#generating-file-contents)).
- ES module syntax: `import`, `export`, `export default`, named and default both directions.

**Not available:**

- `console` — you cannot `console.log` to debug a build file. Use `dagr list` to check that a
  package parsed, and if you need to inspect a computed value, arrange for it to end up in a
  `RUN` step and read it out of the Docker build output.
- `process`, `process.env` — no environment access. Configuration must come from allowed imports
  or literals in `dagr.*.js` files.
- `require`, `module`, `__dirname`, `__filename`.
- `fs`, `path`, `child_process`, or any other Node builtin. A build file cannot read the
  repository it describes.
- `fetch`, `setTimeout`, `setInterval`, and the other host-provided globals.

This is a real sandbox, not a convention. A malicious or buggy `dagr.index.js` can waste CPU and
throw, but it cannot read your SSH keys or phone home.

## Import rules

Only one import specifier form is allowed. Anything else throws:

```
Dagr imports must start with /, got: <specifier>
```

The rules:

- **Specifiers start with `/`.** The slash means monorepo root. Bare specifiers, relative paths,
  URLs, and filesystem paths outside the monorepo are rejected.
- **Filenames match `dagr.*.js`, `dagr.*.json`, `dagr.*.yaml`, or `dagr.*.toml`.** The full
  filename and extension are required. There is no extension inference.
- **JavaScript modules support named and default exports.** JSON, YAML, and TOML files expose
  their parsed value as a deep-frozen default export.

```js
import versions from '/lib/dagr.versions.js'                   // default export
import { writeJson, writeText } from '/lib/dagr.file_utils.js' // named exports
import toolchain from '/config/dagr.toolchain.toml'             // parsed default export
import { stack } from '/stacks/dagr.ts-lib.js'
```

Imported `dagr.*.js` files are ordinary modules. They can import other allowed root-relative
modules and export constants, helper functions, or whole facet factories.

## Caching and sharing

One `dagr` invocation loads the entire repo in a single session with a **shared module cache
keyed by resolved path**. Consequences worth knowing:

- An imported module or data file is loaded at most once per invocation, no matter how many
  `dagr.index.js` files import it. JavaScript module-level state is therefore shared.
- All modules share one V8 context, so they share intrinsics. An object created in
  `lib/dagr.versions.js` is `instanceof Object` in `packages/ui/dagr.index.js`.

## Immutability

Everything the loader returns is deep-frozen: imported data, each parsed `PackageDef`
recursively, and the outer `Map`. Attempting to mutate a target definition from anywhere in
dagr throws in strict mode. This guards against rewriting the graph mid-walk.

Note that freezing applies to the *parsed definition*, not to whatever your `run` function
constructs at build time — that object is freshly created on each call. (//TODO freeze what's returned)

## Shared helper modules

Because `/` paths are root-relative and build files are real JavaScript, the natural way to
avoid repetition is a directory of helpers that export facet factories:

```js
// packages/common/dagr.index.js
import { stack } from '/stacks/dagr.ts-lib.js'

export default stack({
  name: 'common',
  scope: 'myorg',
  version: '0.1.0',
  deps: [{ remote: 'zod' }],
})
```

`stack` returns every facet the package needs — `config`, `ci`, and `dev`. Each package's
`dagr.index.js` becomes a few lines of declaration, and the actual build logic lives in one place.
See [07 — Conventions and layout](07-conventions-and-layout.md#the-libstacks-pattern).
