# Working on dagr

Read the nearest `README.md` before changing an area.

- Engine work: use `.agents/skills/dagr/SKILL.md`.
- Reusable recipe or TypeScript recipe work: use `.agents/skills/dagr-recipes/SKILL.md`.

Keep public documentation and machine-facing guidance synchronized with behavior. Structural or public API changes should update the relevant `README.md`, `AGENTS.md`, `llms.txt`, Agent Skill, workflows, mounts, and examples in the same change.

The repository has three areas:

- `engine/` for Dagr execution and CLI behavior.
- `recipes/` for independently consumable recipes.
- `harness/` for tests that need more than one package at once.

`harness/` contains nothing but mounts and a test target. A test that must see two packages together
— the recipe and an index that consumes it — belongs there, because neither package may reach outside
itself to find the other. Keeping it separate is what lets `//recipes:ci:test` still run with only
`recipes/` present, which is the check that catches a recipe quietly depending on its consumer. Tests
of that kind go under `recipes/tests/repository/`, outside the `tests/*.test.js` glob.

A project's own conventions belong beside its mount, not inside it. `engine/recipes/` holds the
`typescript/` mount and, next to it, `dagr.node-features.js` for features this repository adds and
`dagr.node-cli.js` for the composition that uses them. Put a new convention there first, and move it
into `recipes/typescript/` only once something other than the engine needs it. That keeps the
published recipe free of guesses about what other projects want.

An index is then only what its package is: its own facts, its own targets, and the declaration it
passes to the composition. `engine/dagr.index.js` keeps its version pins because they are coupled to
its `deps` — every npm dependency needs a pin, and a missing one is an error — but it names no
product, tool, or package manager.

Use Dagr itself for validation. For reusable recipes, start with `dagr run //recipes:ci:test` and build the relevant recipe image. For engine work, use the engine CI targets documented in `engine/README.md`.
