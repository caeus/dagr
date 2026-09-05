# dagr

dagr is a programmable build system for monorepos.

A monorepo has work that belongs together: install dependencies, generate code, lint, test,
compile, package, and publish. Those tasks depend on one another, often across package boundaries.
As the repository grows, their ordering gets scattered across package scripts, shell scripts, and
CI configuration.

dagr gives that work one dependency graph and runs the part needed for the result you ask for.
Prerequisites run first, independent work runs concurrently, and unchanged work is reused.

Most monorepo runners let you configure that graph. **dagr lets you calculate it.**

Build definitions are JavaScript programs. They can define targets directly, generate them with
loops and functions, or import the repository's own abstractions. The graph is program output, not
a pile of configuration that must be maintained by hand.

The name compresses **DAG runner** into `dagr`, because its author is obsessed with DAGs. It also
nods to Daguerre and the daguerreotype: `dagr` executes those DAGs by producing and composing
container images.

## Use

Run a target from the repository root:

```sh
dagr run //services/api:ci:build
```

This asks for the `build` target in the `ci` facet of `//services/api`. dagr loads that target and its
transitive dependencies, builds them in dependency order, and materializes any requested output.
It does not run unrelated parts of the repository.

Run several targets together:

```sh
dagr run //services/api:ci:validate //services/api:ci:package //services/api:ci:test
```

Their shared dependencies are built once and independent branches are launched concurrently.

Inspect source targets without running them:

```sh
dagr list
```

See which packages live under the current directory, by relative name:

```sh
dagr pkg ls
```

See what a target would build, without building it:

```sh
dagr show //services/api:ci:build
```

## The graph is code

A `dagr.index.js` file exports the targets for one package. Because it is ordinary JavaScript,
repeated structures do not need to become repeated configuration:

```js
const IGNORE = ['.git', 'out']

const prepare = {
  deps: [],
  run: () => ({
    FROM: 'alpine:3.22',
    steps: [
      { WORKDIR: '/repo' },
      { COPY: { src: 'tools', dest: '/repo/tools' } },
      { RUN: './tools/prepare' },
    ],
    IGNORE,
  }),
}

const commands = {
  format: './tools/check-format',
  test: './tools/test',
}

const checks = Object.fromEntries(
  Object.entries(commands).map(([name, command]) => [
    name,
    {
      deps: ['prepare'],
      run: ({ images }) => ({
        FROM: images['prepare'],
        steps: [
          { COPY: { src: 'src', dest: '/repo/src' } },
          { RUN: command },
        ],
        IGNORE,
      }),
    },
  ]),
)

export default {
  ci: {
    prepare,
    ...checks,
  },
}
```

That example calculates targets from one model. A repository can move the pattern into shared
helpers or generate targets from richer domain models.

Dagr does not prescribe languages, frameworks, package managers, or repository shapes. The
repository defines its own concepts in JavaScript and uses them to produce a concrete task graph.

## Familiar on purpose

A programmable graph should not require an unfamiliar execution model.

Target recipes use Dockerfile concepts your team probably already knows:

- Start from an environment with `FROM`.
- Execute commands with `RUN`.
- Bring in source files with `COPY`.
- Reuse another target with `FROM` or `COPY --from`.

The commands inside those recipes remain the tools the repository already uses: `npm`, `cargo`,
`go build`, `make`, or anything else that runs in a container. dagr coordinates those tools. It
does not replace them.

If you can read JavaScript and a Dockerfile, you can read a dagr build. Familiarity is not a side
effect of the implementation. It is the feature.

## Where it fits

dagr is what happens when [Bazel](https://bazel.build/) and
[EarthBuild](https://github.com/EarthBuild/earthbuild) have a kid.

Like Bazel, dagr treats the build as an explicit, programmable dependency graph rather than a
fixed list of commands. Shared code can calculate targets and encode repository-specific build
patterns. Bazel pursues stronger hermeticity, correctness, and scale through its own language,
rules, and ecosystem. dagr chooses fewer guarantees and far fewer new concepts.

Like EarthBuild, dagr runs work in containers and expresses recipes with familiar Dockerfile
semantics. EarthBuild develops that model into a broad CI/CD framework and its own Earthfile
language. dagr stays focused on being a small, JavaScript-defined build system for a monorepo.

## Philosophy

### The graph belongs to the repository

Every repository has its own concepts. One might distinguish libraries, applications, generated
clients, deployment bundles, or dozens of internal package shapes. Encoding those concepts once
in normal code is more maintainable than repeating their expanded tasks in configuration files.

dagr provides the graph runner and a small target format. The repository provides the model.

### Use existing tools

dagr does not include a compiler, test runner, package manager, release system, or language
plugin. A typecheck target is simply a target whose recipe runs the repository's typechecker.

Docker already provides portable environments, isolated execution, file composition, and a
persistent layer cache. dagr uses those answers instead of inventing parallel systems.

### Pin the runner with the build

dagr is distributed as a container image rather than a language package. A consuming repository
keeps a small bootstrap under `.dagr/`; its `cli.sh` pins an exact image tag derived from a dagr
commit. The runner version therefore lives beside the definitions it interprets.

Updating dagr is an explicit source change that can be reviewed like any other dependency update.
One global launcher merely finds and runs the copy pinned by the current repository.

## Target results

A target declares dependencies and returns a short Dockerfile-like recipe. dagr builds the
dependencies first and makes their results available to the target.

Every completed target is a Docker image. A downstream target can continue from that image or copy
selected files from it, while Docker's layer cache reuses unchanged work.

A target may also declare `EXPORT` to copy selected files from its result back into the package
directory. Only targets requested directly export files, so building a dependency does not spray
intermediate artifacts across the working tree.

Build definitions can use JavaScript, loops, templates, imported `dagr.*.js` modules, and Dagr's
YAML and TOML encoders. They cannot inspect the host filesystem, network, process, or environment,
so the graph comes from repository source.

Filesystem composition stays separate from target definitions. A directory's `dagr.mount.yaml`
requests a volume, while the root monorepo's `.dagr/config.js` assigns its global identity and
`.dagr/volumes.yaml` selects its image recipe. Different paths and requests may therefore converge
on one lazily materialized filesystem without changing Dagr's nested `//` addressing.

`dagr run` loads only packages reached by the requested targets and their dependencies. Docker
output stays quiet unless a build fails; pass `--verbose` to stream it. `dagr list` recursively
lists source targets and leaves mounts opaque.

The complete semantics for targets, dependencies, exports, sandboxed imports, mounted package
trees, caching, and addressing live in the [documentation](docs/README.md).

## Adopt

You need Docker with Buildx and access to the Docker socket.

Create the repository's `.dagr/` bootstrap and pin a dagr commit by following
[Adopting dagr in a new monorepo](docs/10-adopting-in-a-new-monorepo.md). Then install the launcher:

```sh
.dagr/install.sh
export PATH="$HOME/.local/bin:$PATH"
```

The launcher walks up from the current directory to find `.dagr/`, so one global command works
across every repository that uses dagr.

## Documentation

The [complete documentation](docs/README.md) covers:

- getting started and core concepts;
- the `dagr.index.js` format;
- build-file APIs, imports, and shared modules;
- target addresses, dependencies, and exports;
- filesystem composition and mounted package trees;
- CLI behavior and troubleshooting;
- the adoption checklist and troubleshooting.

## Development

```sh
dagr run //engine:ci:typecheck //engine:ci:test
```

## License

See [LICENSE](../LICENSE).
