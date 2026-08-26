# The sandbox and imports

`dagr.index.js` and imported `dagr.*.js` files are evaluated with `vm.SourceTextModule` in a
single fresh V8 context created once per load session. JSON, YAML, and TOML imports are parsed
and exposed as synthetic modules in the same context. Dagr's built-in modules are synthetic
modules too. This is why the dagr image's entrypoint passes `--experimental-vm-modules` to Node.

## What is available

The context starts with code generation from strings and WebAssembly disabled. Dagr then removes
ambient or nondeterministic globals and freezes the remaining global object and intrinsic graph.

**Available:**

- Deterministic ES2022 intrinsics such as `Object`, `Array`, `JSON`, `Math`, `String`, `Map`,
  `Set`, and `Promise`. Their objects and prototypes are frozen so one build module cannot alter
  the language seen by another.
- `Math`, except for `Math.random`.
- A narrow `Buffer` compatibility facade supporting
  `Buffer.from(utf8String).toString('base64')`. No allocation or unsafe-memory APIs are exposed.
  It exists for generated file contents (see
  [03 — Authoring `dagr.index.js`](03-authoring-dagr-index-js.md#generating-file-contents)).
- ES module syntax: `import`, `export`, `export default`, named and default both directions.
- The `dagr:yaml` and `dagr:toml` built-in modules described below.

**Not available:**

- Time, randomness, and host-locale state: `Date`, `Math.random`, and `Intl`.
- `console`: you cannot `console.log` to debug a build file. Use `dagr list` to check that a
  package parsed, and if you need to inspect a computed value, arrange for it to end up in a
  `RUN` step and read it out of the Docker build output.
- `process`, `process.env`: no environment access. Configuration must come from allowed imports
  or literals in `dagr.*.js` files.
- `require`, `module`, `__dirname`, `__filename`.
- `fs`, `path`, `child_process`, or any other Node builtin. A build file cannot read the
  repository it describes.
- `fetch`, `setTimeout`, `setInterval`, and the other host-provided globals.
- `eval`, function-constructor code generation, and WebAssembly compilation.
- GC and shared-memory observation through `WeakRef`, `FinalizationRegistry`, `SharedArrayBuffer`,
  or `Atomics`.

This reduces ambient authority and makes accidental machine-dependent build definitions harder to
write. It does not make hostile JavaScript safe: Node explicitly does not treat `node:vm` as a
security mechanism. Repository code remains trusted input to dagr.

## Dagr built-in modules

Two runtime-provided modules encode ordinary JavaScript data without making serializer packages
available to the sandbox:

```js
import { stringify as stringifyYaml } from 'dagr:yaml'
import { stringify as stringifyToml } from 'dagr:toml'

const yaml = stringifyYaml({ packages: ['packages/*'] })
const toml = stringifyToml({ package: { private: true } })
```

Each module exposes exactly one named export, `stringify`. Dagr owns that small interface and uses
its pinned `yaml` and `smol-toml` dependencies underneath. Unknown `dagr:` modules are rejected;
the underlying parser and serializer APIs are not exposed.

## Import rules

Two import specifier forms are allowed:

- `dagr:yaml` and `dagr:toml` select runtime-provided built-ins.
- A specifier beginning with `/` selects a file from the importing module's source root.

Root-relative file imports follow these rules:

- **Specifiers start with `/`.** The slash means the physical source root containing the importing
  module. For local modules that is the host repository; after a mount boundary it is the mounted
  image's final `WORKDIR`. Bare specifiers, relative paths, URLs, and escapes are rejected.
- **`//` crosses a mount.** `/tools//dagr.shared.js` loads the `/` declared at `tools` in the
  current source root, then imports `dagr.shared.js` from the mounted root. Every additional `//`
  crosses another mount.
- **Filenames match `dagr.*.js`, `dagr.*.json`, `dagr.*.yaml`, or `dagr.*.toml`.** The full
  filename and extension are required. There is no extension inference.
- **JavaScript modules support named and default exports.** JSON, YAML, and TOML files expose
  their parsed value as a deep-frozen default export.

```js
import versions from '/lib/dagr.versions.js'                   // default export
import { writeJson, writeText } from '/lib/dagr.file_utils.js' // named exports
import toolchain from '/config/dagr.toolchain.toml'             // parsed default export
import { stack } from '/stacks/dagr.ts-lib.js'
import mounted from '/tools//dagr.shared.js'
import { stringify as stringifyYaml } from 'dagr:yaml'
```

Imported `dagr.*.js` files are ordinary modules. They can import other allowed root-relative
modules and export constants, helper functions, or whole facet factories. The source root belongs
to the imported module, not its original importer. Thus an import made by
`/tools//dagr.shared.js` resolves `/c/dagr.util.js` inside the mounted `tools` tree.

## Caching and sharing

One `dagr` invocation uses a single VM session and a **shared module cache keyed by logical source
root and resolved path**. `dagr run` still loads packages on demand; sharing applies to whatever
the invocation reaches. Consequences worth knowing:

- An imported module or data file is loaded at most once per logical source root per invocation.
  JavaScript module-level state is therefore shared within that source.
- All modules share one V8 context, so they share intrinsics. An object created in
  `lib/dagr.versions.js` is `instanceof Object` in `packages/ui/dagr.index.js`.
- Each Dagr built-in module is instantiated once for the invocation and shared by every source
  root, including mounted roots.

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
