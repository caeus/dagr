# Working on recipes

Read README.md, typescript/README.md and the dagr-recipes Agent Skill.

Treat each feature as a function returning a namespaced node record. Compose using object spread.
Use named dependencies for all calculations and builds; the engine resolves selections against the final graph.
Keep package and command facts pure. Generate configuration files with ordinary build nodes returning image/path references.
Materialize only through explicit host EXPORT. Do not add another evaluator or compatibility layer.

Validate with `dagr run //recipes:/composition-test //recipes:/test //harness:/test`.
