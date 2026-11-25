# TypeScript graph features

Each feature returns an ordinary record of Dagr nodes under the supplied namespace.
Compose features with object spread. There is no separate graph evaluator or composition object.

```js
import {
  typescript, library, pnpm, vitest, eslint, prettier, hoister, value,
} from '//recipes/ts//dagr.recipe.js'

export default {
  ...typescript('app', {
    packageName: '@example/app',
    deps: [{ name: '@example/lib', target: '//packages/lib:/lib/pack', at: 'prod' }],
  }),
  ...library('app', { runtime: 'node' }),
  ...pnpm('app'),
  ...vitest('app'),
  ...prettier('app'),
  ...eslint('app', { prettier: true }),
  ...hoister('app'),
  '/app/node-base': value('node:22-alpine'),
}
```

The base node must provide an environment with the chosen package manager available.
For example a pnpm base can enable Corepack and prepare the selected pnpm version.

## Paths and composition

`typescript('app')` contributes facts and file nodes such as
`/app/package/name`, `/app/file/build/package.json`, and
`/app/file/build/tsconfig.json`. Product and capability features contribute
`/app/build`, `/app/test`, `/app/lint`, and similar nodes.
Namespaced wildcard dependencies resolve against the final merged graph.
A later object property can replace an individual node.

## Generated files

Generated manifests, compiler configurations and tool configurations are independently
addressable builds, with `{ image, path }` results. Source builds copy exactly the
files they declare. `hoister(name)` contributes `/<name>/dev/hoist` to copy
development files into an image and explicitly export them to the project directory.

## Features

- `typescript(name, options)`: common facts, package metadata and generated files.
- `library(name, options)`, `viteReact(name, options)`, `cloudflareWorker(name, options)`: products.
- `npm(name)`, `pnpm(name)`, `yarn(name)`: package manager commands and files.
- `vitest(name, options)`, `eslint(name, options)`, `biome(name, options)`,
  `prettier(name, options)`, `typedoc(name, options)`, `rollup(name, options)`: capabilities.
- `hoister(name)`: explicit host materialization.

Use `value(data)` and `derive(deps, calculate)` to create ordinary value nodes.
`scope(name, graph)` prefixes local IDs and dependency references, leaving fully
qualified references unchanged. `file(path, deps, { for, render })` contributes
file-producing nodes, one per intent. `command(deps, { for, run })` contributes
pure invocation data, not file builds.

## Local packages

Use an explicit npm package name and an exact artifact node reference:
`{ name: '@example/lib', target: '//packages/lib:/lib/pack', at: 'prod' }`.
The pack node produces an image/path reference to its tarball directory. Names and
filesystem paths are independent. npm dependencies use `{ npm: 'package-name', at: 'dev' }`.
Pin versions through the `versions` option of `typescript`.

Run `dagr show //packages/app:/app/build` to inspect dependencies, and
`dagr run //packages/app:/app/build` to evaluate them.
