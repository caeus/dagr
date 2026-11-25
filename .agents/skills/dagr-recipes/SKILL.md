---
name: dagr-recipes
description: Develop reusable namespaced Dagr graph features, package managers, generated files, and commands.
---

# Dagr recipes

Read recipes/AGENTS.md and recipes/typescript/README.md.

- A feature accepts a namespace and returns an ordinary node record.
- Use object spread to compose features and replace individual nodes.
- Scope prefixes local semantic paths and dependency references, including wildcards. Qualified references remain unchanged.
- Use ordinary value nodes for facts and calculations. Commands describe pure invocation data.
- Use independent file-producing build nodes for generated configuration. Consumers explicitly copy their file references.
- Keep product, capability, package manager and tooling features composable.
- Do not introduce a recipe graph object, registry, separate evaluator or compatibility shim.

Validate with `dagr run //recipes:/composition-test //recipes:/test //harness:/test` and PR checks.
