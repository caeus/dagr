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

The name compresses **DAG runner** into `dagr`.

## Use

Run a target from the repository root:

```sh
dagr run //packages/ui:ci:build
```

This asks for the `build` target in the `ci` facet of `packages/ui`. dagr loads that target and its
transitive dependencies, builds them in dependency order, and materializes any requested output.
It does not run unrelated parts of the repository.

From inside a package, omit the package path:

```sh
cd packages/ui
dagr run ci:build
```

Run several targets together:

```sh
dagr run //packages/ui:ci:lint //packages/ui:ci:typecheck //packages/ui:ci:test
```

Their shared dependencies are built once and independent branches are launched concurrently.

Inspect the complete graph without running its targets:

```sh
dagr list
```

## The graph is code

A `dagr.index.js` file exports the targets for one package. Because it is ordinary JavaScript,
repeated structures do not need to become repeated configuration:

```js
const IGNORE = ['node_modules', '.git']

const install = {
  deps: [],
  run: () => ({
    FROM: 'node:22-alpine',
    steps: [
      { WORKDIR: '/repo' },
      { COPY: { src: 'package*.json', dest: '/repo/' } },
      { RUN: 'npm ci' },
    ],
    IGNORE,
  }),
}

const commands = {
  lint: 'npm run lint',
  typecheck: 'npm run typecheck',
  test: 'npm test',
}

const checks = Object.fromEntries(
  Object.entries(commands).map(([name, command]) => [
    name,
    {
      deps: ['install'],
      run: ({ images }) => ({
        FROM: images['install'],
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
    install,
    ...checks,
  },
}
```

That example calculates three targets from one model. A repository can go further and move the
pattern into a shared `nodePackage()` helper, generate targets from richer models, or compose
reusable helpers for every kind of package it owns.

dagr does not need to know what a Node package, Rust crate, UI application, or deployment is. The
repository defines those ideas in JavaScript and uses them to produce a concrete task graph.

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

[Turborepo](https://turborepo.com/) and [moon](https://moonrepo.dev/) are useful comparisons for
the day-to-day job: they also orchestrate tasks across a monorepo, cache work, and run independent
tasks concurrently. Their task graphs are primarily assembled from declared scripts and
configuration. In dagr, the task graph itself is calculated by a program.

## Philosophy

### The graph belongs to the repository

Every repository has its own concepts. One might distinguish libraries, applications, generated
clients, deployment bundles, or dozens of internal package shapes. Encoding those concepts once
in normal code is more maintainable than repeating their expanded tasks in configuration files.

dagr provides the graph runner and a small target schema. The repository provides the model.

### Use existing tools

dagr does not include a compiler, test runner, package manager, release system, or language
plugin. A typecheck target is simply a target whose recipe runs the repository's typechecker.

Docker already provides portable environments, isolated execution, file composition, and a
persistent layer cache. dagr uses those answers instead of inventing parallel systems.

### Pin the runner with the build

dagr is not published as a package. A consuming repository keeps a small bootstrap under
`.dagr/`, including a Dockerfile that pins an exact dagr commit. The runner version therefore
lives beside the definitions it interprets.

Updating dagr is an explicit source change that can be reviewed like any other dependency update.
One global launcher merely finds and runs the copy pinned by the current repository.

## How it works

A target declares dependencies and returns a short Dockerfile-like recipe. dagr builds the
dependencies first and makes their results available to the target.

Internally, every completed target is a Docker image. This is a mechanism, not the product. It
lets one target continue from another, copy files from another, and reuse Docker's layer cache
without a separate artifact format or task cache.

A target may also declare `EXPORT` to copy selected files from its result back into the package
directory. Only targets requested directly export files, so building a dependency does not spray
intermediate artifacts across the working tree.

Build definitions are evaluated in a `node:vm` sandbox. They can use JavaScript, loops, templates,
and imported `dagr.*.js` modules, but cannot read the filesystem, access the network, or inspect the
host process. Dynamic code generation is disabled, while native `dagr:yaml` and `dagr:toml`
modules encode structured values. Build definitions are expected to calculate the graph from
committed source rather than ambient or nondeterministic state.

`dagr run` loads only packages reached by the requested targets and their dependencies. Docker
output stays quiet unless a build fails; pass `--verbose` to stream it. `dagr list` loads the
complete graph and prints fully resolved dependencies.

The complete semantics for targets, dependencies, exports, sandboxed imports, mounted package
trees, caching, and addressing live in the [documentation](docs/README.md).

## Adopt

You need Docker with buildx and access to the Docker socket. You do **not** need Node, pnpm, or
TypeScript on the host.

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
- the `dagr.index.js` schema;
- sandbox rules and shared modules;
- target addresses, dependencies, and exports;
- mounted package trees;
- CLI behavior and troubleshooting;
- internals and the adoption checklist.

## Development

```sh
pnpm install
make typecheck
make test
```

## License

See [LICENSE](LICENSE).
