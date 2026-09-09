# How Dagr recipes use RDK

The RDK at `recipes/rdk/dagr.rdk.js` is the recipe's only calculation engine.

## Primitive operations

```js
const graph = rdk.graph({
  fact: rdk.value('input'),
  result: rdk.derive(['fact'], fact => `${fact}!`),
})

graph.merge(other)
graph.definitionOf('result')
graph.shake(['result']).compile().result
```

- `value(input, tags?)` provides a fact.
- `derive(deps, factory, tags?)` calculates from explicit dependencies.
- `construct(deps, Class, tags?)` constructs a class.
- `merge` is immutable and right-biased.
- `shake` retains roots, tag matches, and transitive dependencies.
- `compile` resolves retained bindings synchronously once.

## Recipe conventions

Names identify facts and calculations such as `sourceDirectory`, `outputLayout`, and `exec`. Do not
encode an intent or facet into a binding name. Values shared by several outputs stay ordinary.

Open output collections use three tags, attached by their helpers:

- `file(...)` attaches `files`.
- `command(...)` attaches `commands`.
- `target(...)` attaches `targets`.

Targets automatically receive the file and command collections. The `index` binding automatically
receives the target collection. Callers never attach these tags manually.

A target renders the context-aware files, then decides how to materialize the intent's invocations.
Ordering among contributions is their numeric `order`, not the target's dependency list:

```js
target(['exec', 'install'], {
  name: 'test',
  facet: 'ci',
  intent: 'test',
  render(ctx, exec, install) {
    return {
      deps: [],
      run: ({ host }) => ({
        FROM: 'node:22-alpine',
        steps: [
          ...ctx.files({ host }),
          { RUN: install(host) },
          ...runSteps(ctx.invocations(), exec),
        ],
        IGNORE: [],
      }),
    }
  },
})
```

Any other kind of contribution is an ordinary tagged value — `requirement(...)` is one, and a task for
some external runner would be another. Invent a tag, have a file contribution depend on `{ tag }`, and
aggregate. Only files, commands, and targets need helpers, because only they reach a container.

Context is data passed to output rendering. It is not another graph and does not alter how ordinary
dependencies resolve.

`requirement(...)` is an ordinary tagged value used only where independent tooling features must
contribute package, ambient-type, or build-policy facts. It is shared input to file and command
outputs, not another evaluator. Its `packages` are names; the version catalog resolves them.

## Determinism

Factories stay synchronous and deterministic. Do not build RDK nodes around network access, ambient
environment state, mutable registries, or asynchronous resolution. Promises are ordinary values and
are not awaited by `compile()`.
