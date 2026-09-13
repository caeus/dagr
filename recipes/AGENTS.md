# Working on recipes

Read [`README.md`](README.md) first, then use the repository Agent Skill at
[`../.agents/skills/dagr-recipes/SKILL.md`](../.agents/skills/dagr-recipes/SKILL.md).

Keep these rules while editing this area:

- Treat `recipes/` as the publication/mount boundary. `typescript` is a build recipe and uses the engine-native `dagr:rdk` library for recipe-authoring calculations.
- Keep project facts, shared calculations, rendered files, and commands at feature-owned absolute semantic paths.
- Declare derived inputs as a named object. Use `rdk.one('/path')` for one exact binding and `rdk.many('/path/**')` for a frozen record of matches; multiple selectors in one `many()` are unioned.
- Use exact capability bindings such as `/compiler`, `/tester`, and `/linter` for singular dependencies. Never select one implementation from a discovered collection.
- Make targets depend exactly on the canonical files they render. Add adapter bindings ending in `/hoisted` only for host materialization, separate from each producer's canonical file.
- Use `many()` only for explicit open protocols such as `/**/hoisted`, `/**/package-json/script`, and `/**/tooling/for/<consumer>`.
- Keep `/target/<facet>/<name>` as the executable, user-addressable namespace.
- Supply intent, facet, and host as render context. Never lift or duplicate the graph per intent.
- Do not introduce tags, a settings graph, a feature/facet/target registry, another matcher, or another evaluator.
- Keep package-manager behavior in explicit feature graphs such as `npm()`, `pnpm()`, and `yarn()`. A custom manager provides the exact `/package-manager/**` capabilities, canonical config, and its hoister adapter.
- Keep mount identities, workflows, README files, `llms.txt`, `AGENTS.md`, and Agent Skill guidance synchronized with structural changes.
- Put repository-only tests under `recipes/tests/`, not in published recipe directories.

Validate changes with `dagr run //recipes:ci:test` and the relevant recipe image target.
