# Internals

## Source map

- `src/pkg/schema.ts`: index, node, dependency selector, result and recipe validation.
- `src/pkg/loader.ts`: discovery, VM module loading, mount traversal and context.
- `src/pkg/builtins.ts`: YAML, TOML and glob sandbox APIs.
- `src/runner/index.ts`: addresses, selection resolution, memoization and cycle detection.
- `src/runner/target-runner.ts`: evaluate a node; return its value or build an image.
- `src/runner/dockerfile-renderer.ts`: render build instructions.
- `src/runner/docker-builder.ts`: Buildx execution and named contexts.
- `src/runner/docker-extractor.ts`: host materialization.
- `src/commands/index.ts`, `src/wire.ts`: CLI inspection and execution.

## Evaluation

The loader validates the final node record but never evaluates a node. The runner resolves
each named dependency against the project graph, including plural selections. It detects
cycles in the shared dependency graph and memoizes in-flight promises. Once dependencies
complete it passes their values to the node. A wrapped value returns immediately; a wrapped
build is validated, rendered and built. A declared build path produces an image/path reference.

## Docker and host paths

Build context is the physical project directory, including when the project is mounted.
Mounted COPY sources become named build contexts. Build tags are deterministic:
`dagr-` followed by the SHA-256 of the UTF-8 fully qualified node address.
Host exports occur in the CLI only for explicitly requested builds, and cannot cross
mounted project boundaries.

## Bootstrapping

The repository launcher builds the current source with `engine/bootstrap.Dockerfile`.
The engine's dependency pins are shared by the bootstrap and its graph composition in
`engine/dagr.bootstrap.json`. Self-build and release then use the normal graph evaluator.
