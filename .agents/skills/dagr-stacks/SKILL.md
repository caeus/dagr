---
name: dagr-stacks
description: Work effectively with Dagr reusable stacks and their DI-based calculation model. Use when modifying or consuming files under stacks/, authoring dagr.stack.js components, extending the composable TypeScript stack, adding products or capabilities, working with stack-generated configuration or targets, or using the inline DI graph in stacks/di.
---

# Dagr stacks

Use this skill for Dagr's reusable stack components and for repositories extending the composable TypeScript stack.

## First orient yourself

1. Read the nearest stack `README.md` and its public `dagr.stack.js` entry point before editing internals.
2. Identify whether the task changes a stack's public facts/options, a semantic calculation, a tool-specific field, a generated file, a target, or an open-ended contribution.
3. Inspect existing DI keys and dependencies before adding a new one. Prefer extending the existing calculation graph over introducing a parallel registry, manifest model, or evaluator.
4. Read only the relevant reference:
   - [Stack architecture](references/stacks.md) for component boundaries, composition, products, capabilities, target/facet assembly, mounting, and testing.
   - [How stacks use DI](references/di.md) for modules, providers, named dependencies, tags, overrides, shaking, compilation, and modeling rules.

## Core mental model

A Dagr stack is a JavaScript factory that calculates a complete Dagr index from project facts and developer intent. Generated configuration and targets are outputs of that calculation, not canonical inputs.

The composable TypeScript stack uses one native synchronous DI DAG as its calculation engine. Features contribute ordinary DI modules. Semantic nodes derive tool-specific settings; concrete targets are tagged into facets; facets are tagged into the final `index` binding. Dagr selects which target to execute only after this complete index exists.

## Modeling rules

- Model facts once, then derive consequences through named dependencies.
- Prefer tool-neutral semantic nodes when several tools must agree. Do not make one generated tool config canonical for another.
- Keep behavior in the graph. Avoid duplicate booleans/options for state that can be derived from intent or another semantic fact.
- Use ordinary named dependencies for behavioral configuration and invariants.
- Use DI tags only for genuinely open-ended collections such as generated files, tool packages, validations, rule sets, targets, or facets.
- Features return native `di.module()` values. Compose them with `.with(feature)` / `module.merge(feature)` rather than inventing a second extension mechanism.
- Targets remain native Dagr `{ name, deps, run }` values. Do not introduce a separate target specification or target-kind interpreter.
- Package declarations should contain irreducible project facts, not generated consequences such as output paths, `private`, exports, generated files, scripts, or registry policy.
- Preserve explicit ownership. Collisions should fail or be consciously overridden; never depend on contribution ordering.

## Working procedure

When changing the TypeScript stack, trace the dependency path from the user-visible fact or intent through semantic nodes to generated fields and targets. Put the change at the earliest node that actually owns the concept.

When adding a feature, expose facts with `di.toValue()`, derive settings with `di.toFun()`, and contribute to existing open collections with tags. If several outputs need the same decision, introduce or reuse one semantic node rather than calculating the decision independently in each output.

Validate stack changes with the repository's Dagr targets, starting with:

```sh
dagr run //stacks:ci:test
```

Source overview: `stacks/README.md`
Composable TypeScript stack: `stacks/typescript/README.md`
Inline DI implementation: `stacks/di/README.md`
