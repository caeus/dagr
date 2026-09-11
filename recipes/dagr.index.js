const ignore = ['.git', 'node_modules']

const recipeImage = directory => ({
  deps: [],
  run: () => ({
    FROM: 'scratch',
    steps: [
      { COPY: { src: directory, dest: '/recipe' } },
      { WORKDIR: '/recipe' },
    ],
    IGNORE: ignore,
  }),
})

export default {
  ci: {
    test: {
      deps: [],
      run: () => ({
        FROM: 'node:22-alpine',
        steps: [
          { WORKDIR: '/repo' },
          { COPY: { src: '.', dest: '/repo' } },
          { RUN: 'node --experimental-vm-modules --test tests/*.test.js' },
        ],
        IGNORE: ignore,
      }),
    },
    'image-typescript': recipeImage('typescript'),
  },
}
