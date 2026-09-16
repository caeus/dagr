import compositionTests from '//recipes/tests/dagr.composition-tests.js'
import { reportOf } from '//recipes/tests/dagr.testing.js'
import recipeTests from '//recipes/tests/dagr.recipe-tests.js'

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
    // The recipe's tests run while this graph expands, so the RDK is the one the engine serves and
    // the generated files are produced by the real writers. Nothing outside this package is read,
    // which is what keeps proving the recipe needs nothing but itself.
    test: {
      deps: [],
      run: () => {
        const report = reportOf([recipeTests(), compositionTests()])
        if (report.failed.length > 0) {
          throw new Error(`Recipe tests failed:\n${report.lines.join('\n')}`)
        }
        return {
          FROM: 'alpine:3.22',
          steps: [{ RUN: `echo ${JSON.stringify(report.lines.join('\n'))}` }],
          IGNORE: ignore,
        }
      },
    },
    // Scans the tree, so it needs a filesystem the sandbox does not have. It stays a Node test.
    boundaries: {
      deps: [],
      run: () => ({
        FROM: 'node:22-alpine',
        steps: [
          { WORKDIR: '/repo' },
          { COPY: { src: '.', dest: '/repo' } },
          { RUN: 'node --test tests/dagr.recipe-boundaries.test.js' },
        ],
        IGNORE: ignore,
      }),
    },
    'image-typescript': recipeImage('typescript'),
  },
}
