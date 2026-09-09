# Developing Dagr itself

Use this reference when the repository being changed is Dagr itself rather than merely a consumer.

## Source map

The engine lives under `engine/`.

Important areas:

- `engine/src/index.ts`: process entry point.
- `engine/src/wire.ts`: dependency composition and command dispatch.
- `engine/src/commands/`: CLI parsing and command runners.
- `engine/src/pkg/schema.ts`: index, target, recipe, step, and export schemas.
- `engine/src/pkg/loader.ts`: package discovery, sandboxed modules, imports, and traversal.
- `engine/src/pkg/mount-request.ts`: mount request parsing and validation.
- `engine/src/pkg/volume-registry.ts`: root-owned volume identity and implementation policy.
- `engine/src/pkg/sandbox.ts`: restricted JavaScript VM context.
- `engine/src/runner/index.ts`: addresses, graph walk, cycle detection, and per-run memoization.
- `engine/src/runner/target-runner.ts`: recipe evaluation and mounted COPY resolution.
- `engine/src/runner/dockerfile-renderer.ts`: recipe-to-Dockerfile rendering.
- `engine/src/runner/docker-builder.ts`: Buildx invocation and named build contexts.
- `engine/src/runner/docker-extractor.ts`: host `EXPORT` materialization.
- `engine/src/runner/volume-materializer.ts`: volume build, extraction, and cleanup.

Read `engine/docs/08-internals.md` before changing engine behavior that crosses these boundaries.

## Preserve the model

Dagr intentionally keeps a small core model:

- repositories own packages, facet names, target names, and higher-level abstractions;
- Dagr owns discovery, addressing, graph execution, validation, and the small recipe format;
- Docker owns environments, isolation, file composition, and persistent layer caching.

Avoid adding language-, framework-, package-manager-, or CI-specific semantics to the engine when the same behavior can remain repository-owned JavaScript or a reusable recipe.

Build definitions should remain deterministic and isolated from ambient host state.

## Engine execution path

For a requested target, the runner conceptually:

1. loads the exact package;
2. resolves and builds dependencies concurrently;
3. creates `ctx.images` using dependency strings exactly as authored;
4. evaluates `run({ images, host })`;
5. validates the returned recipe;
6. resolves mounted `COPY` sources;
7. renders and builds the Docker image.

Shared prerequisites are memoized by promise within one invocation, so concurrent branches share the same in-flight work.

`dagr show` evaluates a target's `run()` function but does not build its image. Changes to recipe evaluation must therefore preserve deterministic behavior for both `show` and `run`.

## Discovery and mounts

Source discovery recursively walks ordinary directories, skips `.dagr` and `.git`, and does not descend through mount boundaries. Mounts are resolved only when an exact target, import, or mounted `COPY` crosses them.

The invocation root owns `.dagr/config.js` and `.dagr/volumes.yaml`. Configuration found inside mounted repositories must not override root volume policy.

## Exports

Target execution returns export metadata; host materialization is performed only for targets explicitly requested by the user. Keep exports non-transitive.

## Verification

Prefer the smallest relevant target while iterating. For engine-wide validation, the repository documents:

```sh
dagr run //engine:ci:typecheck //engine:ci:test
```

When changing behavior, update or add tests near the owning subsystem and update user-facing documentation if the observable contract changes.

Canonical contributor reference:

- https://github.com/caeus/dagr/blob/main/engine/docs/08-internals.md
- https://github.com/caeus/dagr/blob/main/engine/README.md
