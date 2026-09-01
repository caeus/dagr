# dagr

The Dagr monorepo contains two product areas:

- [`engine/`](engine/) contains the Dagr execution engine, CLI, documentation, and examples.
- [`stacks/`](stacks/) contains independently consumable build stacks and supporting components.

The repository builds and tests both areas with Dagr itself. A pinned published Dagr image
bootstraps the checkout; that image builds the next engine and the stack images.
