# Why dagr?

dagr is for monorepos that need an explicit dependency graph but do not want to replace their
existing tools or adopt a build-system-specific language and rule ecosystem.

Most monorepo runners let a repository configure a graph. dagr lets the repository calculate it
with ordinary JavaScript.

## The graph belongs to the repository

Every repository has its own concepts. One might distinguish libraries, applications, generated
clients, deployment bundles, or dozens of internal package shapes. Encoding those concepts once in
normal code is more maintainable than repeating their expanded tasks in configuration files.

A `dagr.index.js` file can define targets directly, generate them with loops and functions, or
import the repository's shared abstractions. The graph is program output.

dagr provides the graph runner and a small target format. The repository provides the model.

## Execution uses familiar tools

Target recipes use Dockerfile concepts: start from an environment with `FROM`, execute commands
with `RUN`, bring in source with `COPY`, and reuse another target with `FROM` or `COPY --from`.

The commands remain the tools the repository already uses. A typecheck target runs the
repository's typechecker. A package target runs its packager. dagr does not include a compiler,
test runner, package manager, release system, or language plugin.

Docker already provides portable environments, isolated execution, file composition, and a
persistent layer cache. dagr uses those mechanisms instead of building parallel ones.

## The runner is part of the build

dagr is distributed as a container image rather than a language package. A consuming repository
keeps a small bootstrap under `.dagr/`, and its `cli.sh` pins an exact image tag derived from a dagr
commit.

The runtime version therefore lives beside the definitions it interprets. Updating dagr is an
explicit source change that can be reviewed like any other dependency update. One global launcher
finds and runs the version pinned by the current repository.

## Where dagr fits

dagr deliberately occupies the space between command-oriented monorepo runners and comprehensive
build platforms.

- Choose dagr when the graph itself needs repository-specific programming, Docker is an acceptable
  execution boundary, and the repository should keep using its existing tools.
- Choose a conventional monorepo runner when a mostly static task graph is sufficient and targets
  do not need to compose container results.
- Choose Bazel, Buck2, or Pants when stronger hermeticity, remote execution, platform and toolchain
  modeling, dependency inference, or a mature language-rule ecosystem matters more than keeping the
  model small.

dagr chooses fewer guarantees and fewer new concepts. It does not add a persistent content-hash
cache, remote execution service, language-specific rule ecosystem, or general CI/CD framework.

## About the name

The name compresses **DAG runner** into `dagr`, because its author is obsessed with DAGs. It also
nods to Daguerre and the daguerreotype: dagr executes those DAGs by producing and composing
container images.

## Continue

- [Getting started](01-getting-started.md)
- [Concepts](02-concepts.md)
- [Adopting dagr in a new monorepo](10-adopting-in-a-new-monorepo.md)
