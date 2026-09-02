# CLI reference

```text
dagr run [-v|--verbose] <target> [<target>...]
dagr list
dagr pkg ls
dagr show <address> [<address>...]
dagr help [<command>]
dagr --help
```

## `dagr run`

Builds each requested target and its transitive dependencies. Requested targets may run in
parallel; a shared dependency builds once per invocation.

```sh
dagr run //services/api:ci:build
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
`.git`. Mount declarations stay opaque and are not built or extracted by
`dagr list`.

The command is intentionally small and may evolve as Dagr's query needs become clearer.

## `dagr pkg ls`

Prints the packages at or under the working directory, one per line, named relative to it:

```text
.
./examples/starter
```

`.` is the working directory's own package, printed only when it is one. Every other name carries
the `./` prefix, so a listed name pastes straight into an address:

```sh
dagr run ./examples/starter:ci:hello
```

Discovery works exactly as it does for `dagr list`: it recurses through source directories, skips
`.git`, and leaves mount declarations opaque — so mounted packages are not listed. When no package
lies at or under the working directory, the command prints nothing and exits `0`.

## `dagr show`

Prints what Dagr would build, without building it. The address decides how much you get:

```text
[<package>:]<facet>[:<target>]
```

Name a package and it must be anchored — `//` from the repository root, or `./` and `.` relative to
the working directory. Omit the package and it is the working directory's own. What remains is the
facet, then the target, dropped from the right. With the working directory at `//services`:

| Written | Package | Facet | Target | Shows |
| --- | --- | --- | --- | --- |
| `//engine:ci:test` | `//engine` | `ci` | `test` | one target |
| `//engine:ci` | `//engine` | `ci` | — | every target in the facet |
| `//engine` | `//engine` | — | — | every target in the package |
| `./api:ci:test` | `//services/api` | `ci` | `test` | one target |
| `./api:ci` | `//services/api` | `ci` | — | facet |
| `./api` | `//services/api` | — | — | package |
| `.:ci:test` | `//services` | `ci` | `test` | one target |
| `ci:test` | `//services` | `ci` | `test` | one target |
| `ci` | `//services` | `ci` | — | facet |

Note that a lone name is a *facet* here, while a lone name inside a `deps` array is a *target* — a
`deps` entry inherits a facet to complete, and a command line has none.

### Showing a facet or a package

A facet prints its targets with their resolved dependencies. No `run` function is called, so a
facet still lists cleanly even when one of its recipes would fail:

```sh
dagr show //engine:ci
```

```yaml
# //engine:ci
node-pnpm: []
install-typecheck:
  - //engine:config:typecheck
typecheck:
  - //engine:ci:install-typecheck
```

A package nests one level further, facet then target:

```yaml
# //engine
ci:
  node-pnpm: []
config:
  typecheck: []
```

### Showing a target

Naming a target evaluates its `run` function and prints the recipe it returns as YAML:

```sh
dagr show //engine/examples/starter:ci:hello
```

```yaml
# //engine/examples/starter:ci:hello
FROM: alpine:3.22
steps:
  - RUN: echo "hello from dagr"
IGNORE:
  - .git
```

Every entry of the `images` map is substituted with the dependency's own address, so a `FROM` or a
`COPY --from` names the target its image comes from:

```yaml
# //engine:ci:test
FROM: //engine:ci:build
```

The `host` passed to `run` is the real host platform, so a recipe that branches on `host.os` or
`host.arch` renders as it would for the machine you are on. Several targets print as several YAML
documents separated by `---`, in the order requested.

Two ways the output differs from the build it describes. The target is not built, but its package
must still be loaded, so mounts reached by that package's imports are materialized first. And
`COPY` sources that cross a mount boundary appear as authored, rather than rewritten to the
physical build context a real build would use.

## Exit status and streams

- A successful command exits with status `0`.
- Invalid input, unknown targets, or failed builds return a non-zero status.
- Command results use stdout.
- Progress and diagnostics use stderr.

This separation keeps `dagr list` suitable for piping and redirection.
