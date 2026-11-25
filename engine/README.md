# dagr

**Programmable monorepo builds using JavaScript and Docker.**

A Dagr index exports an ordinary record of nodes. Each node declares named dependencies
and returns either a value or a build. Build outputs are values too: image references or
image/path pairs.

```js
export default {
  '/app/name': {
    deps: {},
    run: () => ({ value: 'hello' }),
  },
  '/app/build': {
    deps: { name: '/app/name' },
    run: ({ name }) => ({
      build: {
        FROM: 'alpine:3.22',
        steps: [{ RUN: 'echo ' + JSON.stringify(name) }],
        IGNORE: [],
      },
    }),
  },
}
```

```sh
dagr run //packages/app:/app/build
dagr list
dagr show //packages/app:/app/build
```

Node paths are semantic, independent of project filesystem paths. Compose records with
ordinary JavaScript object spread; the engine evaluates only the requested nodes and their
dependencies. Docker handles persistent build caching.

## Documentation

- [Getting started](docs/01-getting-started.md)
- [Concepts](docs/02-concepts.md)
- [Authoring indexes](docs/03-authoring-dagr-index-js.md)
- [Filesystem composition](docs/03-filesystem-composition.md)
- [Sandbox and imports](docs/04-sandbox-and-imports.md)
- [Dependencies and exports](docs/05-deps-and-exports.md)
- [CLI](docs/06-cli.md)
- [Conventions](docs/07-conventions-and-layout.md)
- [Internals](docs/08-internals.md)
- [Docker-in-Docker](docs/09-docker-in-docker.md)
- [Adopting Dagr](docs/10-adopting-in-a-new-monorepo.md)
- [Troubleshooting](docs/11-troubleshooting.md)

## Development

The repository launcher bootstraps the current engine directly from source. Use Docker
and run from the repository root:

```sh
sh .dagr/cli.sh run //engine:/engine/typecheck //engine:/engine/test
sh .dagr/cli.sh run //recipes:/composition-test //recipes:/test //harness:/test
DOGFEED=true sh .dagr/cli.sh list
```

The TypeScript recipe is an ordinary collection of graph-producing features.
See [recipes/typescript](../recipes/typescript/README.md).

## License

[MIT](../LICENSE).
