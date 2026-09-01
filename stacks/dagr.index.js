const ignore = ['.git', 'node_modules']

const stackImage = directory => ({
  deps: [],
  run: () => ({
    FROM: 'scratch',
    steps: [
      { COPY: { src: directory, dest: '/stack' } },
      { WORKDIR: '/stack' },
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
    'image-di': stackImage('di'),
    'image-typescript': stackImage('typescript'),
  },
}
