# dagr

**Programmable monorepo builds using JavaScript and Docker.**

Define the build graph in ordinary JavaScript. Run only the targets needed for the result you ask
for, with prerequisites ordered, independent work concurrent, and unchanged work reused through
Docker's layer cache.

Most monorepo runners let you configure the graph. **dagr lets you calculate it.**

[Try dagr](docs/01-getting-started.md) · [Why dagr?](docs/00-why-dagr.md)

## One graph for the work that belongs together

A monorepo has work that crosses package boundaries: install dependencies, generate code, lint,
test, compile, package, and publish. Its ordering tends to get scattered across package scripts,
shell scripts, and CI configuration.

dagr gives that work one dependency graph. Ask for one result and dagr follows its transitive
dependencies without running unrelated parts of the repository:

```sh
dagr run //services/api:ci:build
```

Run several targets together and shared dependencies are built once while independent branches run
concurrently:

```sh
dagr run //services/api:ci:validate //services/api:ci:package //services/api:ci:test
```

## The graph is code

A `dagr.index.js` file exports the targets for one package. Because it is JavaScript, a repository
can generate repeated targets from one model instead of maintaining their expanded configuration:

```js
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
        FROM: images.prepare,
        steps: [{ RUN: command }],
        IGNORE: ['.git', 'out'],
      }),
    },
  ]),
)

export default {
  ci: {
    prepare: {
      deps: [],
      run: () => ({
        FROM: 'alpine:3.22',
        steps: [
          { WORKDIR: '/repo' },
          { COPY: { src: '.', dest: '/repo' } },
        ],
        IGNORE: ['.git', 'out'],
      }),
    },
    ...checks,
  },
}
```

Loops, functions, imported helpers, and committed data can calculate the graph. Build definitions
cannot inspect the host filesystem, network, processes, or environment, so the result comes from
repository source rather than ambient machine state.

## Familiar execution, repository-owned concepts

Target recipes use Dockerfile concepts your team probably already knows: `FROM`, `RUN`, `COPY`,
`WORKDIR`, `ENTRYPOINT`, and `CMD`. Every completed target is a Docker image that another target can
continue from or copy files from.

The commands inside those recipes remain the repository's existing tools: `npm`, `cargo`,
`go build`, `make`, or anything else that runs in a container. dagr coordinates them. It does not
replace them with its own compiler, test runner, package manager, release system, or language
plugins.

The repository defines its own packages, facets, targets, and higher-level abstractions. dagr
provides the small target format and graph runner. Docker provides portable environments,
isolation, file composition, and persistent caching.

## Inspect before running

```sh
dagr list                              # list source targets
dagr pkg ls                            # list packages under the current directory
dagr show //services/api:ci:build      # render a target without building it
```

Docker output stays quiet unless a build fails. Pass `--verbose` to stream it.

## Try dagr

You need Docker with Buildx, access to the Docker socket, and a POSIX-compatible shell. A consuming
repository pins its dagr runtime beside its build definitions so upgrades are explicit source
changes.

Follow [Getting started](docs/01-getting-started.md) for the first run or
[Adopting dagr in a new monorepo](docs/10-adopting-in-a-new-monorepo.md) to add it to a repository.

## Documentation

- [Why dagr?](docs/00-why-dagr.md) explains the design choices, fit, and tradeoffs.
- [Concepts](docs/02-concepts.md) introduces packages, facets, targets, results, and caching.
- [Authoring `dagr.index.js`](docs/03-authoring-dagr-index-js.md) defines the target and recipe
  format.
- [CLI reference](docs/06-cli.md) covers commands, output, and exit status.

## Development

```sh
dagr run //engine:ci:typecheck //engine:ci:test
```

## License

See [LICENSE](../LICENSE).
