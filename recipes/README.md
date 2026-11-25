# Dagr recipes

Reusable recipes are ordinary JavaScript functions that produce namespaced node records.
The [TypeScript recipe](typescript/README.md) provides product, tooling, package-manager
and configuration-file nodes. Compose features using object spread.

The engine mounts the recipe independently of its own source. Keep reusable features
free of consumer-specific assumptions. The root repository owns mount implementations.

## Development

```sh
dagr run //recipes:/composition-test //recipes:/test //recipes:/boundaries
dagr run //recipes:/image-typescript
dagr run //harness:/test
```

The generated-file tests consume real image/path references through Dagr, then inspect
the copied files inside a Docker image. The harness also checks the real engine composition.
