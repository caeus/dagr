import compositionTests from '//recipes/tests/dagr.composition-tests.js'
import { reportOf } from '//recipes/tests/dagr.testing.js'
import { recipeGraphs, generatedFileTests } from '//recipes/tests/dagr.recipe-tests.js'

const ignore = ['.git', 'node_modules']

export default {
  ...recipeGraphs(),
  '/test': generatedFileTests,
  '/composition-test': {
    deps: {},
    run: () => {
      const report = reportOf([compositionTests()])
      if (report.failed.length) throw new Error(report.lines.join('\n'))
      return { build: {
        FROM: 'alpine:3.22',
        steps: [{ RUN: 'echo ' + JSON.stringify(report.lines.join('\n')) }],
        IGNORE: ignore,
      } }
    },
  },
  '/boundaries': {
    deps: {},
    run: () => ({ build: {
      FROM: 'node:22-alpine',
      steps: [
        { WORKDIR: '/repo' },
        { COPY: { src: '.', dest: '/repo' } },
        { RUN: 'node --test tests/dagr.recipe-boundaries.test.js' },
      ],
      IGNORE: ignore,
    } }),
  },
  '/image-typescript': {
    deps: {},
    run: () => ({ build: {
      FROM: 'scratch',
      steps: [
        { COPY: { src: 'typescript', dest: '/recipe' } },
        { WORKDIR: '/recipe' },
      ],
      IGNORE: ignore,
    } }),
  },
}
