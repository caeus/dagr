# Working on recipes

Read [`README.md`](README.md) first, then use the repository Agent Skill at
[`../.agents/skills/dagr-recipes/SKILL.md`](../.agents/skills/dagr-recipes/SKILL.md).

Keep these rules while editing this area:

- Treat `recipes/` as the publication/mount boundary. `typescript` is a stack recipe; `rdk` is supporting recipe-authoring infrastructure.
- Model project facts once and derive tool-specific consequences through the RDK graph.
- Do not introduce a second settings graph, feature registry, target registry, or manifest evaluator.
- Keep package-manager behavior behind the TypeScript stack's explicit `packageManager` choice. Do not infer it from the base image.
- Keep mount identities, workflows, README files, `llms.txt`, `AGENTS.md`, and Agent Skill guidance synchronized with structural changes.
- Put repository-only tests under `recipes/tests/`, not in published recipe directories.

Validate changes with `dagr run //recipes:ci:test` and the relevant recipe image target.
