---
name: dagr
description: Author and develop Dagr project graphs, builds, dependencies, mounts, and CLI commands.
---

# Dagr

Read the nearest README and AGENTS.md before editing.

- Each project has a dagr.index.js exporting a flat record of semantic node paths.
- An address is `//project/path:/semantic/node`. The filesystem and semantic portions are independent.
- Every node declares named `deps` and a `run(args)` that returns `{ value }` or `{ build }`.
- Exact dependencies deliver one unwrapped value. Wildcards and arrays deliver path-keyed records resolved against the final graph.
- Builds without a path deliver an image reference. Builds with a path deliver `{ image, path }`.
- Generate files in ordinary builds. Host materialization is explicit EXPORT.
- Compose feature records with object spread. Keep namespaces and node identities user-defined.
- Do not introduce registries, separate graph evaluators, or compatibility shims.
- Build-file imports use the source-root syntax documented in engine/docs/04-sandbox-and-imports.md.

Inspect with `dagr list` and `dagr show <address>`. Run with `dagr run <address>`.
For engine development, read engine/docs/08-internals.md and validate with the repository launcher and PR checks.
