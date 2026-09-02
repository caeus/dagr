# CLI reference

```text
dagr run [-v|--verbose] <target> [<target>...]
dagr list
dagr help [<command>]
dagr --help
```

## `dagr run`

Builds each requested target and its transitive dependencies. Requested targets may run in
parallel; a shared dependency builds once per invocation.

```sh
dagr run //apps/web:ci:build
dagr run //engine:ci:test //stacks:ci:test
```

See [Dependencies and exports](05-deps-and-exports.md#reference-shorthands) for target-address
shorthands.

Only requested targets materialize their own `EXPORT` declarations. An export declared by a
transitive dependency is not written to the host unless that dependency is requested directly.

Each reached target reports progress:

```text
  ▶ //engine:ci:build
  ✓ //engine:ci:build  5.1s
  ▶ //engine:ci:test
  ✗ //engine:ci:test  3.2s
```

Use `--verbose` to stream build output. Without it, Dagr keeps routine output quiet and prints the
relevant tail when a build fails.

## `dagr list`

Recursively scans source directories and prints the targets it finds with their resolved
dependencies:

```text
//engine:ci:build[//engine:ci:install-build]
//engine:ci:test[//engine:ci:build]
//stacks:ci:test[]
```

The output format is `//package:facet:target[dependency, ...]`.

Discovery continues below source packages, including a package at the repository root. It skips
`.git` and `node_modules`. Mount declarations stay opaque and are not built or extracted by
`dagr list`.

The command is intentionally small and may evolve as Dagr's query needs become clearer.

## Exit status and streams

- A successful command exits with status `0`.
- Invalid input, unknown targets, or failed builds return a non-zero status.
- Command results use stdout.
- Progress and diagnostics use stderr.

This separation keeps `dagr list` suitable for piping and redirection.
