# Adopting Dagr in a monorepo

Install the launcher using [Getting started](01-getting-started.md). Begin by
adding a `dagr.index.js` to one project:

```js
export default {
  '/build': {
    deps: {},
    run: () => ({
      build: {
        FROM: 'node:22-alpine',
        steps: [
          { WORKDIR: '/repo' },
          { COPY: { src: '.', dest: '/repo' } },
          { RUN: 'npm ci && npm run build' },
        ],
        IGNORE: ['node_modules', '.git'],
      },
    }),
  },
}
```

Run `dagr run //services/api:/build`. Add prerequisites as named nodes when
they are independently useful. Share graph-producing functions across projects;
compose their records with ordinary object spread. Use file-producing builds to
share generated configuration, and `EXPORT` only for intentional host materialization.
