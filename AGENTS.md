# Working on dagr

Read the nearest README and relevant agent skill before changing code.
Engine work uses `.agents/skills/dagr/SKILL.md`; recipe work uses
`.agents/skills/dagr-recipes/SKILL.md`.

A project index is a plain semantic-path record of nodes. Named dependencies resolve
to values. A node returns a wrapped value or a wrapped build. File-producing builds
return image/path references. Host materialization is explicit via EXPORT. The engine
evaluates a single graph, including wildcard selections after composition.

Do not introduce compatibility shims, reserved dependency keys, secondary evaluators,
or simulated graph engines. Follow design changes through callers. Use normal JavaScript
object spread for feature composition. Keep implementation in ordinary typed source,
not executable strings.

Engine-specific conventions belong in `engine/recipes/`. Reusable features live in
`recipes/typescript/`. Cross-area integration tests live in `harness/`.
Keep public and machine-facing documentation, workflow addresses and tests synchronized.

Run the source-bootstrap launcher:
```sh
sh .dagr/cli.sh run //engine:/engine/typecheck //engine:/engine/test
sh .dagr/cli.sh run //recipes:/composition-test //recipes:/test //harness:/test
```
