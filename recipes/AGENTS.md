# Working on recipes

Read [`README.md`](README.md) first, then use the repository Agent Skill at
[`../.agents/skills/dagr-recipes/SKILL.md`](../.agents/skills/dagr-recipes/SKILL.md).

Keep these rules while editing this area:

- Treat `recipes/` as the publication/mount boundary. `typescript` is a build recipe and uses the engine-native `dagr:rdk` library for recipe-authoring calculations.
- Keep project facts and shared calculations as absolute semantic-path RDK bindings. Generated files and commands are outputs.
- Declare derived inputs as a named object. Use `rdk.one('/path')` for one exact binding and `rdk.many('/path/**')` for a frozen record of matches; multiple selectors in one `many()` are unioned.
- Use `/file/**`, `/command/**`, `/target/**`, and `/requirement/**` for open collections. Their helpers validate values and, where appropriate, render them; paths provide grouping.
- Mark file contributions for host materialization structurally with paths matching `/**/hoisted` or `/**/hoisted/*`. `hoister()` discovers those nodes from the graph namespace; producers do not register with or depend on it.
- Supply intent, facet, and host as render context. Never lift or duplicate the graph per intent.
- Do not introduce tags, a settings graph, a feature/facet/target registry, another matcher, or another evaluator.
- Keep package-manager behavior in explicit feature graphs such as `npm()`, `pnpm()`, and `yarn()`. A custom manager is an ordinary graph, not a core registration.
- Keep mount identities, workflows, README files, `llms.txt`, `AGENTS.md`, and Agent Skill guidance synchronized with structural changes.
- Put repository-only tests under `recipes/tests/`, not in published recipe directories.

Validate changes with `dagr run //recipes:ci:test` and the relevant recipe image target.
