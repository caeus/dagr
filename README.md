# dagr

The Dagr monorepo contains two product areas:

- [`engine/`](engine/) contains the Dagr execution engine, CLI, documentation, and examples.
- [`recipes/`](recipes/) contains independently consumable recipes, including the TypeScript build stack and the RDK calculation primitive.

The repository builds and tests both areas with Dagr itself. A pinned published Dagr image bootstraps the checkout; that image builds the next engine and reusable recipe images.

- [Engine overview](engine/README.md)
- [Engine documentation](engine/docs/README.md)
- [Reusable recipes](recipes/README.md)
- [LLM navigation](llms.txt)
- [Agent instructions](AGENTS.md)
