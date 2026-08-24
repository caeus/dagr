# Concepts

## The four nouns

```
package             a directory containing a dagr.index.js
  └── facet         a named group of targets (you choose the names; "ci" is a common one)
        └── target  a unit of work → exactly one Docker image
```

- **Package** — a directory with a `dagr.index.js` file. Its name is its path relative to the
  repo root: `packages/ui`, `packages/common`. The repo root itself can be a package; its name
  is `.`.
- **Facet** — an arbitrary string key grouping targets. dagr attaches no meaning to facet
  names; `ci` is a convention, not a keyword. You could have `ci`, `release`, and `dev`
  facets side by side.
- **Target** — a `{ deps, run }` pair. One target produces one image.
- **FQT** (fully-qualified target) — the address of a target, written
  `package#facet#target`, e.g. `packages/ui#ci#build`.

## Images are the artifacts

This is the central idea and everything else follows from it.

A target's `run` function returns `{ FROM, steps, IGNORE, EXPORT? }`. dagr renders that to a
Dockerfile and builds it. The resulting image *is* the output. There is no `dist/` directory
on your host unless you explicitly ask for one via `EXPORT`.

Dependencies are image references. When target `B` depends on target `A`, `B`'s `run`
function receives `ctx.images`, a map from dep name to **`A`'s image tag**, and `B` decides how to use it:

```js
// continue from where A left off — B's layers stack on A's
run: ({ images }) => ({ FROM: images['a'], steps: [...] })

// or cherry-pick files out of A into a different base
run: ({ images }) => ({
  FROM: 'node:22-alpine',
  steps: [{ COPY: { from: images['a'], src: '/out/thing.tgz', dest: '/thing.tgz' } }],
})
```

The first form is a linear chain and is by far the most common: `install` → `build` → `pack`,
each one a thin layer on top of the last. The second form is how you pull an artifact across
package boundaries without inheriting the other package's whole filesystem.

## Caching

There are two layers of caching, and only one of them is dagr's.

**Docker's layer cache** does the real work. If a target's rendered Dockerfile and its build
context are unchanged, `docker buildx build` reuses every layer and the target completes
almost instantly. This is why the step order in a target matters: put the stable steps
(writing config, installing dependencies) before the volatile ones (copying source).

**dagr's memo table** is per-process only. Within one `dagr run`, the graph is walked once
and each FQT is built at most once, even if five targets depend on it. Nothing persists
between invocations.

There is deliberately no content hashing, no fingerprint file, and no remote cache. If you
need to know whether a target is up to date, that question is answered by Docker.

## Determinism and the sandbox

`dagr.index.js` files are evaluated in a `node:vm` context with no filesystem, no network, and
no `process`. A build file cannot read a file to decide what to do — it can only compute from
its own literals and from other `dagr.*.js` modules it imports. That is a constraint, and it is the
point: the target graph is a pure function of the repo's source, so `dagr list` gives the same
answer on every machine.

See [04 — The sandbox and `/` imports](04-sandbox-and-imports.md) for exactly what is and
is not available inside a build file.

## What dagr deliberately does not do

- **No test runner, linter, or compiler integration.** A target that typechecks is just a
  target whose last step is `{ RUN: 'pnpm exec tsc --noEmit' }`. If the command exits
  non-zero, the Docker build fails, and so does the target.
- **No watch mode.** For iterating on a dev server, use your package manager directly; dagr
  is for reproducible builds.
- **No parallelism limits or scheduler.** Independent deps are launched with `Promise.all`;
  Docker serializes what it must.
- **No versioning or publishing.** `pnpm pack` inside a target and `EXPORT` the tarball.
