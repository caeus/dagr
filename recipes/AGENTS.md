# Working on recipes

Read [`README.md`](README.md) first, then use the repository Agent Skill at
[`../.agents/skills/dagr-recipes/SKILL.md`](../.agents/skills/dagr-recipes/SKILL.md).

Keep these rules while editing this area:

- Treat `recipes/` as the publication/mount boundary. `typescript` is a build recipe and uses the engine-native `dagr:rdk` library for recipe-authoring calculations.
- Keep project facts, shared calculations, rendered files, and commands at feature-owned absolute semantic paths.
- Declare derived inputs as a named object. `rdk.input({ keys, patterns }, project)` is the fundamental form: exact keys are required, patterns are optional plural dependencies, and the projector defines the named value. Use `rdk.one('/path')` for one required exact binding and `rdk.many('/path')` for optional path-keyed collection injection.
- Keep singular capabilities in the semantic domain that owns them, for example `/typescript/compiler`, `/typescript/tester`, and `/typescript/linter`. Other languages may own corresponding paths independently. Never select one implementation from a discovered collection.
- Put dependencies at their semantic cause-site. A compiler owns its tsconfig dependency; a linter owns its config dependency. Capabilities expose exact optional file sets to targets without wildcard discovery.
- Use wildcard `many()` patterns only for explicit open aggregates such as `/**/hoisted`, `/**/package-json/dependencies`, `/**/package-json/script`, `/**/tsconfig/types`, and `/**/package-manager/builds`.
- Keep `/target/<facet>/<name>` as the executable, user-addressable namespace.
- Supply intent, facet, and host as render context. Never lift or duplicate the graph per intent.
- Do not introduce tags, a settings graph, a feature/facet/target registry, another matcher, or another evaluator.
- Keep package-manager behavior in explicit feature graphs such as `npm()`, `pnpm()`, and `yarn()`. A custom manager provides the exact `/package-manager/**` capabilities, canonical config, and its hoister adapter.
- Keep mount identities, workflows, README files, `llms.txt`, `AGENTS.md`, and Agent Skill guidance synchronized with structural changes.
- Put repository-only tests under `recipes/tests/`, not in published recipe directories.

Validate changes with `dagr run //recipes:ci:test` and the relevant recipe image target.
