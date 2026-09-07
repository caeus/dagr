# Working on reusable components

Read [`README.md`](README.md) first, then use the repository Agent Skill at
[`../.agents/skills/dagr-components/SKILL.md`](../.agents/skills/dagr-components/SKILL.md).

Keep these rules while editing this area:

- Treat `components/` as the publication/mount boundary. `typescript` is a stack; `di` is supporting infrastructure.
- Model project facts once and derive tool-specific consequences through the DI DAG.
- Do not introduce a second settings graph, feature registry, target registry, or manifest evaluator.
- Keep package-manager behavior behind the TypeScript stack's explicit `packageManager` choice. Do not infer it from the base image.
- Keep mount identities, workflows, README files, `llms.txt`, `AGENTS.md`, and Agent Skill guidance synchronized with structural changes.
- Put repository-only tests under `components/tests/`, not in published component directories.

Validate changes with `dagr run //components:ci:test` and the relevant component image target.
