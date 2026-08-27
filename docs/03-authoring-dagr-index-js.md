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

Formally (this is the Zod schema in `src/pkg/schema.ts`):

```
PackageDef = Record<string, FacetDef>
FacetDef   = Record<string, TargetDef>
TargetDef  = { deps: string[], run: (ctx: RunContext) => Run }
RunContext = { images: Record<string, string>, host: HostPlatform }
Run        = { FROM: string, steps: Step[], IGNORE: string[], EXPORT?: Record<string, string> }
IndexDef   = PackageDef | { '/': MountDef }
MountDef   = { FROM: string, steps: Step[], IGNORE: string[] }
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
- Every `Step` object is `.strict()`: an unknown or misspelled key makes validation fail.

## Package location

Each `dagr.index.js` can read its canonical logical package location from
`import.meta.dagr.location`:

```js
const location = import.meta.dagr.location // `//packages/ui`
```

The repository root and the root of every mounted source tree receive `//`. A package `c` inside a
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

The shape is strict. It cannot contain facets, `deps`, `run`, or `EXPORT`. `FROM` and `steps` have
the same Dockerfile semantics as a target's returned run definition, but a mount receives an empty
build context because its directory is the namespace slot being replaced, not an input. A `COPY`
without `from` therefore has nothing useful to copy. `IGNORE` remains required for structural
consistency. The mount cannot depend on a target because it must be materialized before targets can
inside it can be loaded.

After building the image, dagr reads its configured final `WORKDIR`, copies that directory into
private temporary storage, validates that no symlink escapes the copied root, and continues
package discovery there. The final `WORKDIR` is required and cannot be `/`; the entire image
filesystem is not a package namespace. Dagr creates a stopped container, copies the workdir with
`docker cp`, and removes the container. The image needs no shell or utilities, and neither its
entrypoint nor its command runs. The mounted files never get written into the repository.

For example, a mount at `packages/tools` whose final workdir contains `c/dagr.index.js` exposes
`//packages/tools//c:facet:target`. The `//` is a canonical image-boundary marker, not a filesystem
path normalization accident. A `dagr.index.js` at the workdir root exposes
`//packages/tools//:facet:target`. Nested mounts add one `//` at every boundary.

The same boundary syntax works in root-relative build-file imports. For example,
`//packages/tools//dagr.shared.js` materializes the mount at `packages/tools` and imports the file
from its final `WORKDIR`. Imports made by that module use the mounted tree as their `//` root.

Targets discovered inside the mounted tree remain ordinary targets, including their `deps` and
image recipes. They may be used as dependencies. If such a target declares `EXPORT` and is run
directly, dagr rejects the export because its `//` package identity cannot map unambiguously onto
a host filesystem path.

Where a mistake surfaces depends on which half is wrong. The *package* shape — facets, targets,
`deps`, `run`-is-a-function — is checked when `dagr.index.js` loads, and a failure **silently skips
the package**. What `run()` *returns* cannot be checked then, because the function isn't called
until build time; that is validated in `runTarget` and fails loudly, naming the target. See
[11 — Troubleshooting](11-troubleshooting.md#my-package-doesnt-show-up-in-dagr-list).

## `run(deps)`

`run` is called once, at build time, with a `Record<string, string>` mapping each entry of
`deps` to that dependency's built **image tag**. The keys are the dep strings **exactly as you
wrote them** — see [05 — Dependencies and `EXPORT`](05-deps-and-exports.md#the-deps-map).

`run` must be pure. It is called inside the sandbox and has no access to the filesystem.

## Step reference

Each step is a single-key object. The table shows the rendered Dockerfile line
(`src/runner/dockerfile-renderer.ts`).

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

`src` in a `COPY` without `from` is resolved against the **build context**, which is the
package's own directory. For `packages/ui`, `{ COPY: { src: 'src', dest: '/repo/src' } }`
copies `packages/ui/src`. You cannot `COPY` a path outside your package — that is Docker's
rule, not dagr's.

What the context excludes is controlled by `IGNORE`, described next.

## `IGNORE`

`IGNORE` is the target's `.dockerignore`, as a list of patterns. dagr writes it verbatim
alongside the generated Dockerfile — one entry per line — and passes no ignore rules of its own.

```js
IGNORE: ['node_modules', '.git']
```

It is **required**, deliberately. Nothing is excluded unless a target says so, which means the
cost of a large build context is always visible in the target that pays it rather than hidden
in dagr. `IGNORE: []` is legal and means "upload everything in the context".

Because it is required and has no default, the sensible pattern is to keep the list in one
place and import it, rather than repeating literals:

```js
// lib/dagr.dockerignore.js
export const RECOMMENDED_IGNORE = ['node_modules', '.git']
```

```js
import { RECOMMENDED_IGNORE } from '//lib/dagr.dockerignore.js'

run: () => ({ FROM: '…', steps: [ … ], IGNORE: RECOMMENDED_IGNORE })
```

Excluding `node_modules` matters more than it looks. A package whose `install` target exports
`node_modules` back to the host will otherwise upload that entire tree as build context on
every subsequent build.

With `from`, `src` is an absolute path inside the referenced image and the context is not
involved:

```js
{ COPY: { from: images['//packages/common:ci:pack'], src: '/out/pkg.tgz', dest: '/repo/pkg.tgz' } }
```

## Ordering gotcha: `WORKDIR` creates directories

Steps that write files need their target directory to exist. Docker's `WORKDIR` creates it;
a bare `RUN ... > /repo/file` does not. So put `WORKDIR` before any file-writing step:

```js
steps: [
  { WORKDIR: '/repo' },              // creates /repo
  writeJson('/repo/package.json', pkg),
  { RUN: 'pnpm install' },
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

Base64 is not decoration. A naive `printf '%s' '<content>'` breaks the moment the content
contains a newline, a quote, or a `$`. Base64-encoding on the host and decoding in the
container sidesteps shell quoting entirely. `Buffer` is injected into the sandbox specifically
so this pattern works.

The tradeoff: any change to the file's contents invalidates that layer and everything after
it. That is correct behaviour, and it is why config writes belong early in the step list,
before the expensive install.

## A worked example

```js
import { PNPM_VERSION } from '//lib/dagr.versions.js'
import { writeJson, writeText } from '//lib/dagr.file_utils.js'
import { RECOMMENDED_IGNORE } from '//lib/dagr.dockerignore.js'

const TSCONFIG = {
  extends: '@tsconfig/strictest/tsconfig.json',
  include: ['src/**/*'],
  compilerOptions: { noEmit: true, module: 'ESNext', moduleResolution: 'Bundler' },
}

const PACKAGE_JSON = {
  name: '@scope/thing',
  type: 'module',
  devDependencies: { typescript: '6.0.3', '@tsconfig/strictest': '2.0.8' },
}

export default {
  ci: {
    install: {
      deps: [],
      run: () => ({
        FROM: 'node:22-alpine',
        steps: [
          { RUN: `corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate` },
          { WORKDIR: '/repo' },
          writeJson('/repo/package.json', PACKAGE_JSON),
          writeJson('/repo/tsconfig.json', TSCONFIG),
          { RUN: 'pnpm install --prod=false' },
        ],
        IGNORE: RECOMMENDED_IGNORE,
      }),
    },
    typecheck: {
      deps: ['install'],
      run: ({ images }) => ({
        FROM: images['install'],
        steps: [
          { COPY: { src: 'src', dest: '/repo/src' } },
          { WORKDIR: '/repo' },
          { RUN: 'pnpm exec tsc --noEmit' },
        ],
        IGNORE: RECOMMENDED_IGNORE,
      }),
    },
  },
}
```

Note the split: `install` writes config and installs dependencies but never touches `src/`,
so editing a source file leaves the `install` image fully cached and only `typecheck` rebuilds.
Getting this boundary right is most of what makes a dagr repo feel fast.
