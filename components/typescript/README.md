# Composable TypeScript stack

This component calculates generated TypeScript/tool configuration and executable Dagr targets from
project facts. Consumers mount this directory and choose the product/capabilities they need.

```js
import typescript, {
  eslint,
  library,
  prettier,
  typedoc,
  vitest,
} from '//components/ts//dagr.stack.js'
import versions from '//config/dagr.versions.yaml'

const stack = typescript({
  base: '//packages/base:ci:node',
  packageManager: 'npm',
  scope: 'caeus',
  versions,
})
  .with(library({ runtime: 'node', sourceMaps: true, assets: ['README.md', 'LICENSE'] }))
  .with(prettier({ semi: true, trailingComma: 'all' }))
  .with(vitest({ globals: true, typecheck: true }))
  .with(eslint({ prettier: true, explicitReturnTypes: true }))
  .with(typedoc({ title: 'Wyr' }))

export default stack({
  location: import.meta.dagr.location,
  version: '0.1.0',
  metadata: { license: 'MIT' },
})
```

`base` and `packageManager` are explicit. The stack does not infer a package manager from the base
target. Built-in package managers are:

- `packageManager: 'npm'`
- `packageManager: 'pnpm'`

The selected package manager owns install, local-binary execution, host-specific install, package
packing, and package-manager-specific configuration. Local package dependencies are copied as
Dagr-produced tarballs and the install-only manifest points at those tarballs with `file:` URLs, so
that mechanism is not tied to pnpm hooks. The manifest used for packing/publishing keeps the normal
package dependency range.

For pnpm, the stack emits `pnpm-workspace.yaml` only when an active feature needs explicit build-script
allowances. npm needs no equivalent generated file.

## Calculation model

The stack is one synchronous DI calculation DAG:

```text
external facts + conventions + features
                  |
                  v
           semantic settings
                  |
                  v
        tool-specific fields
                  |
                  v
 concrete targets --tag--> facets --tag--> index
```

`typescript()` owns common policy and target machinery. Every `.with(...)` value is an ordinary
`di.module()` merged into that graph. The final result is resolved with:

```js
module.shake(['index']).compile().index
```

Generated files and targets are outputs, not canonical project truth. When several tools need to
agree, derive them from one semantic node. For example, `outputLayout` drives TypeScript output and
package entry points rather than making either generated file authoritative.

Conventions are replaceable roots of the graph:

```js
typescript({
  base: '//packages/base:ci:node',
  packageManager: 'pnpm',
  conventions: {
    sourceDirectory: 'source',
    outputDirectory: 'build',
  },
})
```

## Products

Exactly one product feature should own the package's product semantics:

- `library()` for portable or Node libraries, build output, declarations, tarballs, and pack targets.
- `cloudflareWorker()` for Cloudflare Worker TypeScript/runtime policy.
- `viteReact()` for browser TypeScript, Vite/React configuration, build targets, and host `node_modules` export.

## Capabilities

Capabilities are independently composable DI modules:

- `prettier()` adds formatting policy and generated Prettier configuration.
- `biome()` adds Biome policy/configuration and `ci:lint`.
- `vitest()` adds test policy/configuration and `ci:test`.
- `eslint()` adds ESLint policy/configuration and `ci:lint`.
- `typedoc()` adds TypeDoc configuration and `ci:docs`.

Open-ended contributions use DI tags for collections such as tool packages, generated files,
validations, build dependencies, rule sets, targets, and facets. Behavioral settings use named
bindings so ownership and dependency paths remain inspectable.

## Package declaration

The package declaration contains irreducible package facts:

```js
stack({
  location: import.meta.dagr.location,
  version: '1.2.3',
  deps: [
    { npm: 'zod', at: 'prod' },
    { pkg: '//packages/shared', at: 'prod' },
  ],
  metadata: {
    description: 'Example package',
    license: 'MIT',
  },
})
```

Do not configure generated consequences such as `private`, output directories, package exports,
generated files, scripts, or registry policy in the declaration.

## Extending the stack

Features are ordinary DI modules. A feature can add semantic settings, generated files, packages,
validations, or targets without a separate plugin registry:

```js
import { ciFacet, di, target } from '//components/ts//dagr.stack.js'

export const health = () => di.module({
  healthTarget: di.toFun(
    [],
    () => target('health', {
      deps: [],
      run: () => ({ FROM: 'alpine:3.22', steps: [{ RUN: 'echo healthy' }], IGNORE: [] }),
    }),
    [ciFacet.targets],
  ),
})
```

The mount alias (`//components/ts` above) belongs to the consuming repository. The published component
itself does not depend on that alias.
