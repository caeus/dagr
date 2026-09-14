# Working on dagr

Read the nearest `README.md` before changing an area.

- Engine work: use `.agents/skills/dagr/SKILL.md`.
- Reusable recipe or TypeScript recipe work: use `.agents/skills/dagr-recipes/SKILL.md`.

Keep public documentation and machine-facing guidance synchronized with behavior. Structural or public API changes should update the relevant `README.md`, `AGENTS.md`, `llms.txt`, Agent Skill, workflows, mounts, and examples in the same change.

Do not hide nontrivial JavaScript or TypeScript implementation inside strings or template literals in JavaScript or TypeScript source. This is very strongly discouraged, including `vm.compileFunction(...)` and multiline `vm.runInContext(...)` source strings. Keep implementation as ordinary typed source code. Strings passed to VM APIs are appropriate for actual externally supplied/user-authored module source or tiny intrinsic lookups such as `globalThis`, not for nested engine implementations.

## No hacky workarounds

Refactors are allowed to expose breakage. Do not hide that breakage with compatibility shims,
bridging adapters, reserved-key tricks, or other workarounds. Follow the new design through the system
and fix the abstractions and callers properly.

If a change breaks callers, change the callers. If it breaks an abstraction, change the abstraction. If
neither is possible within the change, stop and say so: a loud failure is better than a quiet mechanism
that makes the failure invisible. When a refactor removes the reason some scaffolding existed, delete
the scaffolding in the same change — that is the moment it stops being a solution and starts being a
lie.

This is not about `adapter()` in the TypeScript recipe, which publishes a canonical binding into a
consumer's path. That is the intended composition mechanism, not a bridge over breakage.

Three examples from this repository's own history, all found long after the fact:

- `$files` and `$commands`: reserved dependency names that smuggled framework-injected inputs past the
  caller (`03ff083`). `208b1ab` removed the auto-injection that justified them and kept `$files`
  regardless, so the guard outlived its problem — and every caller passed an empty dependency record,
  meaning it protected against a collision that could not happen.
- A `sed` step in `.dagr/volumes.yaml` rewriting `from 'dagr:rdk'` to a test fixture, so an engine
  predating that built-in could still load the workspace mount. Correct when written; dead as soon as
  the pin advanced, and nothing reported it.
- A 504-line RDK reimplementation and a 93-line module loader under `recipes/tests/`, so tests could
  run outside the engine. Two tests then passed against the double while the real thing behaved
  differently: one asserted a `.yaml` file equalled a JSON object, the other depended on the version
  catalog being empty.

Each was defensible when written. Each became false the moment its reason disappeared, and not one of
them failed loudly when that happened.

The repository has three areas:

- `engine/` for Dagr execution and CLI behavior.
- `recipes/` for independently consumable recipes.
- `harness/` for tests that need more than one package at once.

`harness/` contains nothing but mounts and a test target. A test that must see two packages together
— the recipe and an index that consumes it — belongs there, because neither package may reach outside
itself to find the other. Keeping it separate is what lets `//recipes:ci:test` still cover the recipe
with nothing but `recipes/` present, which is the check that catches a recipe quietly depending on its
consumer.

Tests run while a graph expands, not in a separate runner. A package's index imports its test modules
and a target reports them, so the engine loads them and `dagr:rdk`, `dagr:yaml` and module resolution
are the real ones rather than doubles. `recipes/tests/dagr.testing.js` is the hand-woven runner, and
`recipes/tests/typescript/` mounts the recipe under test, because a recipe's own `//` imports assume it
is the source root — true only when it is crossed as a mount. Only a test that needs a real filesystem,
like the boundary scan, stays a Node test.

A project's own conventions belong beside its mount, not inside it. `engine/recipes/` holds the
`typescript/` mount and, next to it, `dagr.node-features.js` for features this repository adds and
`dagr.node-cli.js` for the composition that uses them. Put a new convention there first, and move it
into `recipes/typescript/` only once something other than the engine needs it. That keeps the
published recipe free of guesses about what other projects want.

An index is then only what its package is: its own facts, its own targets, and the declaration it
passes to the composition. `engine/dagr.index.js` keeps its version pins because they are coupled to
its `deps` — every npm dependency needs a pin, and a missing one is an error — but it names no
product, tool, or package manager.

Use Dagr itself for validation. For reusable recipes, start with `dagr run //recipes:ci:test` and build the relevant recipe image. For engine work, use the engine CI targets documented in `engine/README.md`.