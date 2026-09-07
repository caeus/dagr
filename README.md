# dagr

The Dagr monorepo contains two product areas:

- [`engine/`](engine/) contains the Dagr execution engine, CLI, documentation, and examples.
- [`components/`](components/) contains independently consumable calculation components, including the TypeScript build stack and its DI calculation primitive.

The repository builds and tests both areas with Dagr itself. A pinned published Dagr image bootstraps the checkout; that image builds the next engine and reusable component images.

- [Engine overview](engine/README.md)
- [Engine documentation](engine/docs/README.md)
- [Reusable components](components/README.md)
- [LLM navigation](llms.txt)
- [Agent instructions](AGENTS.md)
