---
name: dagr-components
description: Work with Dagr reusable components and the DI-based settings calculation model under components/. Use when modifying the TypeScript stack, package-manager behavior, generated configuration, targets, facets, mounts, publication, or the inline DI component.
---

# Dagr components

Use this skill for reusable components under `components/`, especially the composable TypeScript stack and its synchronous DI calculation DAG.

## First orient yourself

1. Read `components/README.md` and the nearest component `README.md`.
2. Identify whether the change affects an external fact, convention, semantic calculation, tool-specific field, generated file, target, facet, or publication boundary.
3. Inspect the existing DI dependency path before adding a new setting.
4. Read the relevant reference:
   - [Component architecture](references/components.md)
   - [How components use DI](references/di.md)

## Core model

`components/` is the independently consumable publication boundary. `typescript` is a stack; `di` is a supporting component.

The TypeScript stack calculates a complete Dagr index from project facts and developer intent. Generated files and targets are outputs. One native synchronous DI DAG owns the calculation:

```js
module.shake(['index']).compile().index
```

Features are ordinary DI modules merged into that graph. Do not introduce a second calculation graph, feature registry, target registry, or manifest evaluator.

## Modeling rules

- Model a fact once, then derive consequences through named dependencies.
- Prefer tool-neutral semantic nodes when multiple generated outputs must agree.
- Use tags only for intentionally open collections such as generated files, package lists, validations, rule sets, targets, and facets.
- Keep package declarations limited to irreducible project facts.
- Keep target values native Dagr `{ name, deps, run }` objects.
- Make ownership collisions visible rather than depending on contribution order.
- Keep calculations synchronous and deterministic.

## Package managers

The TypeScript stack requires both `base` and `packageManager`. Package manager selection is explicit and must not be inferred from a base target or image name.

Built-in managers are `npm` and `pnpm`. Manager-specific install, local binary execution, packing, host install, and generated manager configuration belong behind the package-manager adapter. Tool features provide manager-neutral command bodies such as `tsc --noEmit` or `vitest run`.

Local package dependencies are Dagr-produced tarballs. The install-only manifest points local dependencies at `file:` tarballs, while the normal generated package manifest retains package dependency ranges.

## Working procedure

Trace a requested behavior from the public fact through semantic nodes to every generated field and target it affects. Change the earliest node that owns the concept.

When changing structure or public behavior, keep `README.md`, `AGENTS.md`, `llms.txt`, this Agent Skill, workflows, mount identities, and publication paths synchronized.

Validate with:

```sh
dagr run //components:ci:test
dagr run //components:ci:image-di
dagr run //components:ci:image-typescript
```
