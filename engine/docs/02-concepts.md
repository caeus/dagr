# Concepts

A repository contains projects at filesystem paths. A project is a directory containing
`dagr.index.js`. Its default export is a record of nodes keyed by absolute semantic paths.
There is no required relationship between a node path and the project's directories.

A fully qualified node address combines the two independent coordinates:

```text
//packages/web:/app/file/build/package.json
```

`//packages/web` is the project. `/app/file/build/package.json` is the node.

## One graph

Each node has named dependency references and a `run(args)` function. The engine
resolves dependency values before calling the function. An exact dependency yields one
value; a wildcard or array of selectors yields a record of matching node paths and values.

```js
{
  deps: { config: '/app/config', plugins: '/app/plugin/*' },
  run: ({ config, plugins }) => ({ value: { config, plugins } })
}
```

Values may be arbitrary JavaScript values. A build returns an image reference, or an
image/path pair if the recipe declares a path. Both are passed to consumers as ordinary
dependency values.

## Composition

Functions return ordinary node records. Compose them with object spread. Later records
replace earlier definitions with the same semantic path. Wildcards resolve against the
final merged index, not against an individual feature.

## Execution and caching

The evaluator follows dependencies, detects cycles, and shares the same in-flight result
for a node within one invocation. Independent nodes can run concurrently. Docker owns
persistent image/layer caching. Definitions should be deterministic.

## Files and mounts

A generated file lives inside its own image and can be copied into another build using
its image/path reference. Host materialization is explicit through `EXPORT`.

Filesystem composition is independent of semantic graph composition. A mounted project
uses a double-slash boundary, for example `//tools//packages/core:/build`.
See [Filesystem composition](03-filesystem-composition.md).
