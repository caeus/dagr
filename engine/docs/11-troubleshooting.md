# Troubleshooting

## Unknown node

Use `dagr list` to inspect discovered definitions. A complete address is
`//packages/web:/app/build`. The project is a filesystem path; the node is a semantic
path. For a local reference, use `/app/build` from the current project.

## Invalid definition or result

The default export must be a record of absolute node paths. Each node has named
`deps` and a function `run`. The function must return exactly one of
`{ value: ... }` or `{ build: ... }`. See [Authoring indexes](03-authoring-dagr-index-js.md).

## Import or volume mount failure

Check allowed file names and the source-root import path. Check
`dagr.mount.yaml`, the root `.dagr/config.js` volume identity, and
`.dagr/volumes.yaml` implementation. See [Filesystem composition](03-filesystem-composition.md).

## Dependency cycle

Inspect the named edges with `dagr show`. Wildcards may select a node itself;
narrow the selection so it only matches intended producers.

## A generated file is missing

Use a build with an absolute `path` and a step that actually writes the file.
Use `WORKDIR` before writing into a new directory. Consumers copy the file by
its image/path reference, not by a host path.

## EXPORT produced nothing

Only an explicitly requested build materializes its own exports.
Check trailing slash semantics in [Dependencies and exports](05-deps-and-exports.md).

## Docker failures or rebuilds

Use `dagr run --verbose` to see build output. Confirm Docker and Buildx are
available, and keep definitions deterministic so Docker layers can be reused.
