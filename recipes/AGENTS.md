# Working on recipes

Read [`README.md`](README.md) first, then use the repository Agent Skill at
[`../.agents/skills/dagr-recipes/SKILL.md`](../.agents/skills/dagr-recipes/SKILL.md).

Keep these rules while editing this area:

- Treat `recipes/` as the publication/mount boundary. `typescript` is a build recipe; `rdk` is supporting recipe-authoring infrastructure.
- Keep project facts and shared calculations as ordinary RDK nodes. Generated files and commands are outputs.
- Use `file`, `command`, and `target` for open contributions; each helper owns its RDK tag.
- Supply intent, facet, and host as render context. Never lift or duplicate the graph per intent.
- Do not introduce a settings graph, feature/facet/target registry, or another evaluator.
- Keep package-manager behavior in explicit feature graphs such as `npm()`, `pnpm()`, and `yarn()`. A custom manager is an ordinary graph, not a core registration.
- Keep mount identities, workflows, README files, `llms.txt`, `AGENTS.md`, and Agent Skill guidance synchronized with structural changes.
- Put repository-only tests under `recipes/tests/`, not in published recipe directories.

Validate changes with `dagr run //recipes:ci:test` and the relevant recipe image target.
