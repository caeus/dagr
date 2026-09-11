// A package whose only content is mounts. Some tests have to see two packages at once — the recipe
// and an index that consumes it — and neither package can reach outside itself to find the other.
// Mounting both here keeps that dependency declared, and keeps //recipes:ci:test able to prove the
// recipe works with nothing but the recipe present.
const ignore = ['.git']

export default {
  ci: {
    test: {
      deps: [],
      run: () => ({
        FROM: 'node:22-alpine',
        steps: [
          { WORKDIR: '/repo' },
          // The layout the loader expects: it reads /repo/tests, and resolves the engine as a sibling.
          { COPY: { src: 'recipes//tests/', dest: '/repo/tests/' } },
          { COPY: { src: 'recipes//typescript/', dest: '/repo/typescript/' } },
          { COPY: { src: 'engine//dagr.index.js', dest: '/engine/dagr.index.js' } },
          { COPY: { src: 'engine//recipes/', dest: '/engine/recipes/' } },
          {
            RUN: 'node --experimental-vm-modules --test'
              + " 'tests/*.test.js' 'tests/repository/*.test.js'",
          },
        ],
        IGNORE: ignore,
      }),
    },
  },
}
