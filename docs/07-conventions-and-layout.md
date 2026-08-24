# Conventions and layout

Some things dagr hardwires. Others are conventions that happen to work well. Knowing
which is which saves time.

## Hardwired (you cannot change without editing dagr)

- **The build file is named `dagr.index.js`.** `PACKAGE_FILE` in `src/pkg/loader.ts`.
- **Only two places are scanned**: the repository root, and everything under `packages/`.
  A package at `apps/web/dagr.index.js` is invisible.
- **`packages/` must exist.** The loader unconditionally reads it; a repo without that
  directory fails with `ENOENT`.
- **The root `dagr.index.js` gets the package name `.`** — so its FQTs look like `.#ci#deploy`.
- **Discovery stops at the first `dagr.index.js`.** The walker descends `packages/` recursively,
  but as soon as a directory contains a `dagr.index.js` it records that package and does **not**
  look inside it. Nested packages (`packages/group/sub/dagr.index.js` where
  `packages/group/dagr.index.js` also exists) are unreachable. To group packages, leave the
  intermediate directory without a build file — `packages/group/a/dagr.index.js` and
  `packages/group/b/dagr.index.js` both work and are named by their full relative path.
- **Imports are monorepo-root-relative and start with `/`.** Only files named
  `dagr.*.js`, `dagr.*.json`, `dagr.*.yaml`, or `dagr.*.toml` can be imported.
- **The build context is the package's own directory** — always, with no option to widen or
  narrow it.

## Conventions (yours to change)

- **Facet names `config` / `ci` / `dev`.** dagr attaches no meaning to any of them. Nothing
  breaks if you use `build`, `release`, or `default`.
- **Target names `manifest` / `install` / `build` / `pack` / `typecheck` / `sync`.** Also
  arbitrary. The chain `install → build → pack` is a useful shape, not a requirement.
- **Excluding `node_modules` and `.git` from the build context.** This is now a recommendation
  expressed as `IGNORE`, not something dagr bakes in — see
  [03 — `IGNORE`](03-authoring-dagr-index-js.md#ignore). Keep the list in `lib/dagr.dockerignore.js` and
  import it.
- **A `base` package holding shared base images.** See below.
- **`lib/` and `stacks/` for shared `dagr.*.js` helpers.** See below.

## Recommended repo shape

```
<repo root>/
├── dagr.index.js           # root package '.', for repo-wide targets (deploy, docs)
├── dagr/                   # vendored dagr; the dagr launcher finds the repo by this
│   ├── cli.sh
│   ├── dagr
│   ├── install.sh
│   ├── Dockerfile
│   ├── src/
│   └── docs/
├── lib/                    # low-level Dagr helpers (file writing, version pins)
│   ├── dagr.versions.js
│   ├── dagr.file_utils.js
│   └── dagr.dockerignore.js
├── stacks/                 # facet factories, one per project archetype
│   ├── dagr.ts-lib.js
│   ├── dagr.ts-ui.js
│   └── dagr.ts-executable.js
└── packages/
    ├── base/dagr.index.js     # shared base images
    ├── common/dagr.index.js
    └── ui/dagr.index.js
```

## The `lib/`+`stacks/` pattern

Writing out `install`/`build`/`typecheck` by hand in every package gets old fast, and it lets
packages drift. The fix is to put the logic in a shared `dagr.*.js` module that returns **every facet
a package needs**, so each `dagr.index.js` is one call.

**`lib/`** holds primitives — no knowledge of your project archetypes:

```js
// lib/dagr.versions.js — one place to bump a version
export const PNPM_VERSION = '11.20.0'

export default {
  typescript: '6.0.3',
  react: '19.2.8',
  zod: '4.4.3',
}
```

```js
// lib/dagr.file_utils.js — turn computed content into a step
export function writeText(path, content) {
  return { RUN: `echo "${Buffer.from(content).toString('base64')}" | base64 -d > ${path}` }
}
export function writeJson(path, value) {
  return writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}
```

```js
// lib/dagr.dockerignore.js — the recommendation IGNORE used to hardwire
export const RECOMMENDED_IGNORE = ['node_modules', '.git']
```

**`stacks/`** holds one factory per archetype, each returning all of that archetype's facets:

```js
// stacks/dagr.ts-lib.js
import versions from '/lib/dagr.versions.js'
import { writeJson } from '/lib/dagr.file_utils.js'
import { RECOMMENDED_IGNORE } from '/lib/dagr.dockerignore.js'

const BASE = 'packages/base#ci#node-pnpm'
const IGNORE = RECOMMENDED_IGNORE

export function stack({ name, scope, version, deps = [] }) {
  const localDeps = deps.filter(d => 'local' in d)
  const packTargets = localDeps.map(d => `packages/${d.local}#ci#pack`)

  return {
    config: {
      manifest: {
        deps: [BASE],
        run: ({ images }) => ({ FROM: images[BASE], steps: [ /* write package.json, tsconfig, … */ ], IGNORE }),
      },
    },
    dev: {
      sync: {
        deps: ['config#manifest'],
        run: ({ images }) => ({
          FROM: images['config#manifest'], steps: [], IGNORE,
          EXPORT: { '/repo/package.json': 'package.json', '/repo/tsconfig.json': 'tsconfig.json' },
        }),
      },
    },
    ci: {
      install: {
        deps: ['config#manifest', ...packTargets],
        run: ({ images }) => ({ FROM: images['config#manifest'], steps: [ /* pnpmfile, install */ ], IGNORE }),
      },
      build:     { deps: ['install'], run: ({ images }) => ({ FROM: images['install'], steps: [ /* … */ ], IGNORE }) },
      pack:      { deps: ['build'],   run: ({ images }) => ({ FROM: images['build'],   steps: [ /* … */ ], IGNORE }) },
      typecheck: { deps: ['install'], run: ({ images }) => ({ FROM: images['install'], steps: [ /* … */ ], IGNORE }) },
    },
  }
}
```

Each package then declares only what makes it different:

```js
// packages/common/dagr.index.js
import { stack } from '/stacks/dagr.ts-lib.js'

export default stack({
  name: 'common',
  scope: 'myorg',
  version: '0.1.0',
  deps: [{ remote: 'zod' }, { remote: '@orpc/contract' }],
})
```

### Why `config` is its own facet

`config#manifest` exists so that exactly one target generates a package's manifests, and both
`ci` and `dev` consume them:

```
config#manifest    package.json, tsconfig.json, … (cheap, no install)
   ├── ci#install    + .pnpmfile.cjs + dep tarballs + pnpm install
   └── dev#sync      EXPORT the manifests to the host
```

Neither `ci` nor `dev` owns the manifest, so the two can't drift. `dev#sync` gets a
host-usable manifest purely by *not* adding the container-only `.pnpmfile.cjs` step — the
generated file already carries plain version ranges. Cross-facet deps like
`deps: ['config#manifest']` resolve exactly like same-facet ones.

A useful convention inside these factories is tagging deps by kind — `{ remote: 'zod' }` for a
registry package versus `{ local: 'common' }` for a sibling package — so the factory can turn
locals into `pack` target deps and remotes into `package.json` entries. That distinction is
yours to define; dagr only ever sees the resulting `deps` strings.

## The base-image package

Every target starts from *some* image, and repeating the same `corepack enable && corepack
prepare pnpm@...` in ten targets means ten copies of that layer. Instead, make it a target:

```js
// packages/base/dagr.index.js
import { PNPM_VERSION } from '/lib/dagr.versions.js'

export default {
  ci: {
    'node-pnpm': {
      deps: [],
      run: () => ({
        FROM: 'node:22-alpine',
        steps: [{ RUN: `corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate` }],
      }),
    },
  },
}
```

Then every install target uses `FROM: images['packages/base#ci#node-pnpm']`. One image, built
once, shared by the whole repo — and bumping the pnpm version invalidates exactly one layer.

## Depending on the local package manager inside a container

The hardest part of containerizing a monorepo build is sibling dependencies: a container holds
one package, so there is no workspace for the package manager to resolve against.

The pattern that works with dagr's image-as-artifact model:

1. Give each library a `pack` target ending in `pnpm pack --pack-destination /out`, then rename
   the tarball to drop the version: `mv /out/*.tgz /out/<name>.tgz`. Without the rename, every
   consumer would have to know the library's *version* to construct the `COPY` path.
2. In the consumer's `install` target, declare a dep on that `pack` target and `COPY --from=`
   the tarball in.
3. Rewrite the sibling dependency to `file:./<name>.tgz` before installing, via a generated
   `.pnpmfile.cjs` with a `readPackage` hook. The rewrite happens in memory at install time, so
   the `package.json` on disk is never touched.

The result is a genuine install from a real tarball, so the consumer's image proves the
library's packaged artifact actually works.

### Keep the manifest portable

It's tempting to write the sibling dependency as `workspace:*`, but that string is meaningless
to anything outside a pnpm workspace — including the published tarball. A plain satisfies-anything
range keeps the manifest valid everywhere:

```json
{ "dependencies": { "@myorg/common": ">=0.0.0" } }
```

Three things fall out of that choice. The consumer needs no knowledge of the sibling's version,
so there's no cross-package coupling. The same manifest works in CI (where `.pnpmfile.cjs`
redirects it to a tarball) and on a developer's host (where a real workspace root links the
sibling), which is what lets a single `config#manifest` target serve both. And since there's no
`workspace:` marker to key on, the pnpmfile matches on the package *name* instead:

```js
if (name.startsWith(`@${scope}/`)) deps[name] = `file:./${name.slice(scope.length + 2)}.tgz`
```

For host-side resolution to prefer the sibling over the registry, the workspace root needs
`linkWorkspacePackages: true` — pnpm 10 changed that default to `false`.
