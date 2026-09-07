# Working on dagr

Read the nearest `README.md` before changing an area.

- Engine work: use `.agents/skills/dagr/SKILL.md`.
- Reusable recipe or TypeScript stack work: use `.agents/skills/dagr-recipes/SKILL.md`.

Keep public documentation and machine-facing guidance synchronized with behavior. Structural or public API changes should update the relevant `README.md`, `AGENTS.md`, `llms.txt`, Agent Skill, workflows, mounts, and examples in the same change.

The repository has two main areas:

- `engine/` for Dagr execution and CLI behavior.
- `recipes/` for independently consumable recipes.

Use Dagr itself for validation. For reusable recipes, start with `dagr run //recipes:ci:test` and build the relevant recipe image. For engine work, use the engine CI targets documented in `engine/README.md`.
