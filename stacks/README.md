# dagr stacks

Reusable build stacks for [dagr](https://github.com/caeus/dagr).

A stack is a self-contained JavaScript factory for a project archetype. It returns the complete set
of dagr facets and targets needed by that archetype, while the consuming repository supplies what
makes a particular package different.

## Configuration model

Stacks accept project facts and developer intent, then calculate generated configuration and the
complete Dagr target index. Generated files are outputs, not canonical project truth.

The calculation itself is an explicit DAG. Each node comes from external configuration, workspace
context, or a calculation over named dependency nodes. Targets collect into facets through DI tags;
facets collect into the root index. Target selection happens later, in Dagr, and never enters the
stack DI.

This means a stack owns consistency between tools. For example, a compiler output directory and a
package manifest's entry points and file list are one derived agreement, not unrelated consumer
options. Likewise, a publishing target derives a publishable manifest; publishability is not a
second boolean that can contradict it. A publishing location owns registry visibility and other
location-specific policy.

[`typescript`](typescript/) is the composable stack. Its library, Cloudflare worker, Vite React,
test, lint, format, and documentation definitions merge into one native DI module. `ts-library` is
retained as the earlier, target-parameterized implementation.

## Convention

Each top-level directory contains one independently consumable component. Build stacks expose:

```text
<stack-name>/
├── dagr.stack.js
└── ...
```

- `dagr.stack.js` is the stack's public entry point.
- Its default export is the stack factory.
- Everything needed by a stack lives inside its directory.
- Component directories contain only files consumers may mount; repository tests live in `tests/`.
- Published components are immutable filesystem images tagged by their Git tree SHA.
- `latest` is published for convenience; consumers should pin the tree SHA.
- Release tags are scoped by stack, for example `ts-library/v1.2.0`.

Supporting components use a descriptive `dagr.*.js` entry point instead.

## Mounting

Published components can be selected by the root monorepo's `.dagr/config.js`:

```js
export const mount = id => {
  if (id === 'github.com/caeus/dagr-stacks/typescript') return {
    FROM: 'ghcr.io/caeus/dagr-stacks-typescript:<tree-sha>',
    steps: [],
    IGNORE: [],
  }
}
```

The local `dagr.index.js` declares only the logical ID:

```js
export default { '/': 'github.com/caeus/dagr-stacks/typescript' }
```

The image's final `WORKDIR` is `/stack`, so Dagr materializes the component contents directly.
Nested mounts keep their existing source-based pins until the corresponding image already exists;
consumers never need to reference an artifact before it has been published.

The main-branch publish workflow publishes:

- `ghcr.io/caeus/dagr-stacks-di`
- `ghcr.io/caeus/dagr-stacks-typescript`

A consuming repository can then mount a stack under `stacks/<alias>` and import across the mount
boundary:

```js
import typescript from '//stacks/ts//dagr.stack.js'

const stack = typescript({
  base: '//packages/base:ci:node-pnpm',
  scope: 'internal',
})

export default stack({
  location: import.meta.dagr.location,
  deps: [{ npm: 'zod', at: 'prod' }],
})
```

The alias belongs to the consuming repository. The image tag is an explicit, reviewable build
input. Source mounts remain possible when working directly from a repository checkout.

## Available components

| Component | Description |
| --- | --- |
| [`di`](di/) | Immutable, synchronous dependency-injection graph for inline JavaScript composition |
| [`typescript`](typescript/) | Composable TypeScript products and capabilities with generated configuration and tagged targets |
| [`ts-library`](ts-library/) | Curried TypeScript library stack with generated manifests, build, pack, typecheck, and local dependency tarballs |

Stacks stay together here until one genuinely requires separate ownership, permissions, or release
infrastructure.
