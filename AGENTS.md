# Working on dagr

Read the nearest `README.md` before changing an area.

- Engine work: use `.agents/skills/dagr/SKILL.md`.
- Reusable recipe or TypeScript recipe work: use `.agents/skills/dagr-recipes/SKILL.md`.

Keep public documentation and machine-facing guidance synchronized with behavior. Structural or public API changes should update the relevant `README.md`, `AGENTS.md`, `llms.txt`, Agent Skill, workflows, mounts, and examples in the same change.

The repository has two main areas:

- `engine/` for Dagr execution and CLI behavior.
- `recipes/` for independently consumable recipes.

A project's own conventions belong beside its mount, not inside it. `engine/recipes/` holds the
`typescript/` mount and, next to it, `dagr.node-features.js`: features this repository composes onto
the published recipe. Put a new convention there first, and move it into `recipes/typescript/` only
once something other than the engine needs it. That keeps the published recipe free of guesses about
what other projects want, and it keeps `engine/dagr.index.js` down to facts about the engine.

Use Dagr itself for validation. For reusable recipes, start with `dagr run //recipes:ci:test` and build the relevant recipe image. For engine work, use the engine CI targets documented in `engine/README.md`.
